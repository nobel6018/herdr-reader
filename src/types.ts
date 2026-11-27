// Shapes shared by the server and the phone app.
// @see docs/herdr-reader.md

export type AgentKind = "claude-code" | "codex";

/** The program's own status word (hc 7501 record). "unknown": it never said, or it exited. */
export type TerminalStatus = "idle" | "working" | "done" | "blocked" | "error" | "unknown";

export interface SessionSummary {
  address: string;
  agent: AgentKind | null;
  status: TerminalStatus;
  where: string;
  cwd: string | null;
  machine: string | null;
  updatedMs: number;
  lastText: string | null;
}

export interface ToolDetail {
  type: "diff" | "output";
  text: string;
}

export type Entry =
  | { kind: "user"; id: string; at: number; text: string }
  | { kind: "assistant"; id: string; at: number; markdown: string }
  | { kind: "tool"; id: string; at: number; name: string; summary: string; detail: ToolDetail | null; ok: boolean | null }
  | { kind: "screen"; id: string; at: number; text: string };

/** What the server pushes over /api/stream. "entries" upserts by id; "reset" replaces the whole list. */
export type StreamEvent =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "entries"; address: string; entries: Entry[] }
  | { type: "reset"; address: string; entries: Entry[] };
