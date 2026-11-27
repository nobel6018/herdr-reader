// HTTP API and the phone app. Binds to 127.0.0.1 only; expose it with `tailscale serve`.
// @see docs/herdr-reader.md

import index from "../web/index.html";
import { HcError, pressKey, send } from "./hc.ts";
import { Hub } from "./hub.ts";
import type { StreamEvent, TerminalStatus } from "./types.ts";

const PORT = Number(process.env.HERDR_READER_PORT ?? 7878);
const ALLOWED_LOGIN = process.env.HERDR_READER_ALLOWED_LOGIN?.trim() || null;
const MAX_TEXT = 20_000;
const DEFAULT_LIMIT = 200;
const PUBLIC = new URL("../web/public/", import.meta.url).pathname;

/** UI key name to hc key name. Nothing else can be pressed from the phone. */
const KEYS: Record<string, string> = {
  esc: "esc",
  enter: "enter",
  "ctrl+c": "ctrl+c",
  up: "up",
  down: "down",
  ...Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => [k, k])),
};

/**
 * How a message goes in per status. "idle": hc's atomic --if idle gate. "plain": no gate, because hc's gate
 * only accepts the exact word idle (a finished turn reports done; a plain shell reports nothing).
 */
const SEND_GATE: Record<TerminalStatus, "idle" | "plain" | "refuse"> = {
  idle: "idle",
  done: "plain",
  error: "plain",
  unknown: "plain",
  working: "refuse",
  blocked: "refuse",
};

const REFUSED: Partial<Record<TerminalStatus, string>> = {
  working: "작업 중이라 보내지 않았습니다. 끝난 뒤에 보내거나 먼저 중단하세요.",
  blocked: "승인 요청이 떠 있어 보내지 않았습니다. 선택지 버튼으로 먼저 답하세요.",
};

function hcMessage(error: HcError): string {
  switch (error.kind) {
    case "status_mismatch":
      return `상태가 바뀌어 보내지 않았습니다 (${error.message}).`;
    case "blocked":
      return REFUSED.blocked!;
    case "finished":
      return "세션이 끝났습니다.";
    case "not_found":
    case "machine_unknown":
      return "터미널을 찾지 못했습니다.";
    case "unavailable":
      return "터미널에 닿지 못했습니다. 원격 머신 연결을 확인하세요.";
    default:
      return error.message;
  }
}

const hub = new Hub();
hub.start();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** With HERDR_READER_ALLOWED_LOGIN set, only that Tailscale user (header set by `tailscale serve`) gets in. */
function denied(req: Request): Response | null {
  if (ALLOWED_LOGIN && req.headers.get("tailscale-user-login") !== ALLOWED_LOGIN) return fail(403, "허용되지 않은 사용자입니다.");
  return null;
}

/** POSTs must be JSON from this app's own page: blocks cross-site form posts and fetches. */
function rejectedPost(req: Request): Response | null {
  const login = denied(req);
  if (login) return login;
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415, "JSON으로 보내야 합니다.");
  const origin = req.headers.get("origin");
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")].filter(Boolean);
  let sameOrigin = req.headers.get("sec-fetch-site") === "same-origin";
  try {
    if (origin && hosts.includes(new URL(origin).host)) sameOrigin = true;
  } catch {
    sameOrigin = false;
  }
  if (!origin || !sameOrigin) return fail(403, "다른 출처에서 온 요청은 받지 않습니다.");
  return null;
}

async function target(address: string) {
  return hub.terminal(decodeURIComponent(address));
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => null);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stream(req: Request): Response {
  const session = new URL(req.url).searchParams.get("session");
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    closed = true;
    if (ping) clearInterval(ping);
    unsubscribe();
  };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event: StreamEvent) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      write("retry: 3000\n\n");
      ping = setInterval(() => write(": ping\n\n"), 15_000);
      const stop = await hub.subscribe(session, send);
      if (closed) stop();
      else unsubscribe = stop;
    },
    cancel: cleanup,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  development: process.env.NODE_ENV !== "production" ? { hmr: false } : false,
  routes: {
    "/": index,
    "/manifest.webmanifest": () =>
      new Response(Bun.file(PUBLIC + "manifest.webmanifest"), { headers: { "content-type": "application/manifest+json" } }),
    "/icon-192.png": new Response(Bun.file(PUBLIC + "icon-192.png")),
    "/icon-512.png": new Response(Bun.file(PUBLIC + "icon-512.png")),
    "/apple-touch-icon.png": new Response(Bun.file(PUBLIC + "apple-touch-icon.png")),

    "/api/sessions": {
      GET: async (req) => denied(req) ?? json(await hub.sessions()),
    },
    "/api/sessions/:address/entries": {
      GET: async (req) => {
        const no = denied(req);
        if (no) return no;
        const terminal = await target(req.params.address);
        if (!terminal) return fail(404, "터미널을 찾지 못했습니다.");
        const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || DEFAULT_LIMIT, 1), 1000);
        return json(await hub.entries(terminal, limit));
      },
    },
    "/api/sessions/:address/screen": {
      GET: async (req) => {
        const no = denied(req);
        if (no) return no;
        const terminal = await target(req.params.address);
        if (!terminal) return fail(404, "터미널을 찾지 못했습니다.");
        const [screen] = await hub.entries({ ...terminal, agent: null }, 1);
        return json({ text: screen?.kind === "screen" ? screen.text : "" });
      },
    },
    "/api/sessions/:address/send": {
      POST: async (req) => {
        const no = rejectedPost(req);
        if (no) return no;
        const terminal = await target(req.params.address);
        if (!terminal) return fail(404, "터미널을 찾지 못했습니다.");
        const { text } = await body(req);
        if (typeof text !== "string" || !text.trim()) return fail(400, "보낼 내용이 없습니다.");
        if (text.length > MAX_TEXT) return fail(400, `${MAX_TEXT}자까지 보낼 수 있습니다.`);
        const gate = SEND_GATE[terminal.status];
        if (gate === "refuse") return fail(409, REFUSED[terminal.status]!);
        try {
          await send(terminal.address, text, gate === "idle");
          return json({ ok: true });
        } catch (error) {
          if (error instanceof HcError) return fail(409, hcMessage(error));
          throw error;
        }
      },
    },
    "/api/sessions/:address/keys": {
      POST: async (req) => {
        const no = rejectedPost(req);
        if (no) return no;
        const terminal = await target(req.params.address);
        if (!terminal) return fail(404, "터미널을 찾지 못했습니다.");
        const { key } = await body(req);
        const hcKey = typeof key === "string" ? KEYS[key] : undefined;
        if (!hcKey) return fail(400, "누를 수 없는 키입니다.");
        try {
          await pressKey(terminal.address, hcKey);
          return json({ ok: true });
        } catch (error) {
          if (error instanceof HcError) return fail(409, hcMessage(error));
          throw error;
        }
      },
    },
    "/api/stream": {
      GET: (req, server) => {
        const no = denied(req);
        if (no) return no;
        server.timeout(req, 0);
        return stream(req);
      },
    },
  },
  fetch() {
    return fail(404, "없는 경로입니다.");
  },
  error(error) {
    console.error(error);
    return fail(500, "서버 오류가 났습니다.");
  },
});

console.log(`herdr-reader on ${server.url}${ALLOWED_LOGIN ? " (Tailscale login required)" : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.stop();
    process.exit(0);
  });
}
