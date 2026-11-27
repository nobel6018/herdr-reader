// The only module that runs the hc CLI. Parses its JSON into domain types at the boundary.
// @see docs/herdr-reader.md

import path from "node:path";
import type { AgentKind, TerminalStatus } from "./types.ts";

export interface Terminal {
  address: string;
  /** Another machine's name for addresses like "box/t3"; null on this Mac. */
  machine: string | null;
  agent: AgentKind | null;
  status: TerminalStatus;
  where: string;
  cwd: string | null;
  title: string;
  /** The foreground program's pid (on its own machine). */
  pid: number | null;
  updatedMs: number;
  live: boolean;
}

export class HcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUSES: readonly TerminalStatus[] = ["idle", "working", "done", "blocked", "error"];
const PROGRAMS: Record<string, AgentKind> = { claude: "claude-code", "claude-code": "claude-code", codex: "codex" };

export function parseTerminal(raw: unknown): Terminal | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, any>;
  if (typeof t.address !== "string") return null;
  const slash = t.address.indexOf("/");
  const app = typeof t.status?.app === "string" ? t.status.app : null;
  const program = Array.isArray(t.foreground?.argv) && typeof t.foreground.argv[0] === "string" ? path.basename(t.foreground.argv[0]) : null;
  const word = t.status?.state;
  return {
    address: t.address,
    machine: slash > 0 ? t.address.slice(0, slash) : null,
    agent: PROGRAMS[app ?? ""] ?? PROGRAMS[program ?? ""] ?? null,
    status: STATUSES.includes(word) ? word : "unknown",
    where: typeof t.labels?.where === "string" && t.labels.where ? t.labels.where : t.title || t.address,
    cwd: typeof t.foreground?.cwd === "string" ? t.foreground.cwd : typeof t.cwd === "string" ? t.cwd : null,
    title: typeof t.title === "string" ? t.title : "",
    pid: typeof t.foreground?.pid === "number" ? t.foreground.pid : null,
    updatedMs: typeof t.status_ms === "number" ? t.status_ms : typeof t.created_ms === "number" ? t.created_ms : 0,
    live: t.state === "live",
  };
}

/** Without HC_TERMINAL_ID, hc does not attribute what the phone sends to the terminal this server was started from. */
const HC_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "HC_TERMINAL_ID")) as Record<string, string>;

async function hc(args: string[], timeoutMs = 15_000): Promise<unknown> {
  const proc = Bun.spawn(["hc", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: HC_ENV });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  let body: any = null;
  try {
    body = JSON.parse(stdout);
  } catch {
    // not JSON: reported below
  }
  if (code !== 0 || body?.error) {
    const error = body?.error;
    throw new HcError(error?.kind ?? "failed", error?.message ?? ((stderr || stdout).trim() || `hc ${args[0]} exited ${code}`));
  }
  return body;
}

export async function readScreen(address: string, lines = 200): Promise<string> {
  const body = (await hc(["read", "--json", "--lines", String(lines), "--", address], 20_000)) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}

/** Pastes text and presses Enter. ifIdle makes hc refuse unless the status is exactly idle at that moment. */
export async function send(address: string, text: string, ifIdle: boolean): Promise<void> {
  await hc(["send", "--json", ...(ifIdle ? ["--if", "idle"] : []), "--", address, text], 90_000);
}

export async function pressKey(address: string, key: string): Promise<void> {
  await hc(["keys", "--json", "--", address, key]);
}

export async function getTerminal(address: string): Promise<Terminal | null> {
  try {
    return parseTerminal(await hc(["get", "--json", "--", address]));
  } catch (error) {
    if (error instanceof HcError && (error.kind === "not_found" || error.kind === "machine_unknown")) return null;
    throw error;
  }
}

export interface TerminalFeed {
  /** Every terminal: the first line of the stream, and again after the subscriber fell behind. */
  snapshot(terminals: Terminal[]): void;
  /** Something about this terminal changed (status, title, created, finished, removed, ...). */
  changed(address: string): void;
  error(message: string): void;
}

/**
 * Follows `hc events --json`: a snapshot line, then one JSON-RPC `event` notification per fact change.
 * Restarts the stream when it ends. Returns a stop function.
 */
export function followTerminals(feed: TerminalFeed): () => void {
  let stopped = false;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  function handle(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return feed.error("hc events: unreadable line");
    }
    const payload = message?.params ?? message;
    if (Array.isArray(payload?.terminals)) {
      feed.snapshot(payload.terminals.map(parseTerminal).filter((t: Terminal | null): t is Terminal => t !== null));
    } else if (typeof payload?.terminal === "string") {
      feed.changed(payload.terminal);
    }
  }

  async function loop() {
    while (!stopped) {
      proc = Bun.spawn(["hc", "events", "--json"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const decoder = new TextDecoder();
      let carry = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        carry += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = carry.indexOf("\n")) >= 0) {
          handle(carry.slice(0, newline));
          carry = carry.slice(newline + 1);
        }
      }
      const code = await proc.exited;
      if (stopped) return;
      feed.error(`hc events exited with ${code}; restarting`);
      await Bun.sleep(2_000);
    }
  }
  void loop();
  return () => {
    stopped = true;
    proc?.kill();
  };
}
