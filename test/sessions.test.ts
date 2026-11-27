import { expect, test } from "bun:test";
import { orderSessions } from "../src/sessions.ts";
import type { SessionSummary } from "../src/types.ts";

const s = (address: string, over: Partial<SessionSummary>): SessionSummary => ({
  address, agent: "claude-code", status: "idle", where: address, cwd: null, machine: null, updatedMs: 0, lastText: null, ...over,
});

test("waiting agent sessions come first, then working, then ended, newest first; other terminals go last", () => {
  const ordered = orderSessions([
    s("shell", { agent: null, status: "unknown", updatedMs: 99 }),
    s("idle", { status: "idle", updatedMs: 50 }),
    s("working", { status: "working", updatedMs: 10 }),
    s("done-old", { status: "done", updatedMs: 1 }),
    s("blocked-new", { agent: "codex", status: "blocked", updatedMs: 5 }),
  ]);
  expect(ordered.map((x) => x.address)).toEqual(["blocked-new", "done-old", "working", "idle", "shell"]);
});
