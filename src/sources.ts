// Where each agent keeps its transcript, and which parser reads it.
// Anything not found here falls back to the terminal screen (see hub.ts).
// @see docs/herdr-reader.md

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Terminal } from "./hc.ts";
import { createClaudeParser } from "./parse/claude.ts";
import { createCodexParser } from "./parse/codex.ts";
import type { TranscriptParser } from "./parse/common.ts";
import type { AgentKind } from "./types.ts";

export interface TranscriptSource {
  /** The transcript file of the session running in this terminal, or null. */
  locate(terminal: Terminal): Promise<string | null>;
  createParser(): TranscriptParser;
}

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const ROLLOUT = /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]*\.jsonl$/;

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** The pid and every process below it: agents often run under a wrapper. */
async function processTree(root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const line of (await run(["ps", "-A", "-o", "pid=,ppid="])).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!) ?? []));
  return out;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function claudeTranscript(sessionId: string): Promise<string | null> {
  const projects = path.join(CLAUDE_HOME, "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function claudeSessionId(pid: number): Promise<string | null> {
  try {
    const session = JSON.parse(await readFile(path.join(CLAUDE_HOME, "sessions", `${pid}.json`), "utf8"));
    return typeof session.sessionId === "string" ? session.sessionId : null;
  } catch {
    return null;
  }
}

async function newestRolloutIn(cwd: string): Promise<string | null> {
  const root = path.join(CODEX_HOME, "sessions");
  const files: { file: string; mtime: number }[] = [];
  for await (const rel of new Bun.Glob("*/*/*/rollout-*.jsonl").scan({ cwd: root, onlyFiles: true })) {
    const file = path.join(root, rel);
    files.push({ file, mtime: (await stat(file)).mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(0, 30)) {
    const head = (await Bun.file(file).slice(0, 64 * 1024).text()).split("\n")[0] ?? "";
    try {
      const meta = JSON.parse(head);
      if (meta.type === "session_meta" && meta.payload?.cwd === cwd) return file;
    } catch {
      // first line longer than the slice; skip
    }
  }
  return null;
}

export const sources: Record<AgentKind, TranscriptSource> = {
  "claude-code": {
    async locate(terminal) {
      if (terminal.machine || !terminal.pid) return null;
      for (const pid of await processTree(terminal.pid)) {
        const id = await claudeSessionId(pid);
        if (id) return claudeTranscript(id);
      }
      return null;
    },
    createParser: createClaudeParser,
  },
  codex: {
    async locate(terminal) {
      if (terminal.machine || !terminal.pid) return null;
      const pids = await processTree(terminal.pid);
      const open = (await run(["lsof", "-Fn", "-p", pids.join(",")]))
        .split("\n")
        .filter((l) => l.startsWith("n") && ROLLOUT.test(l))
        .map((l) => l.slice(1));
      if (open[0]) return open[0];
      return terminal.cwd ? newestRolloutIn(terminal.cwd) : null;
    },
    createParser: createCodexParser,
  },
};
