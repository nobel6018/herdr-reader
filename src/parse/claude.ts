// Claude Code transcript lines (~/.claude/projects/<slug>/<sessionId>.jsonl) to entries. Pure.
// @see docs/herdr-reader.md

import type { Entry, ToolDetail } from "../types.ts";
import {
  type TranscriptParser,
  clipLines,
  clipOutput,
  counts,
  diffDetail,
  firstLine,
  genericSummary,
  jsonObject,
  lineDiff,
  str,
  timeOf,
} from "./common.ts";

type ToolEntry = Extract<Entry, { kind: "tool" }>;
type Block = Record<string, unknown>;

/** hc wraps text it delivers on behalf of another terminal: <hc from="t3">…</hc>. */
const HC_NOTE = /^<hc\b[^>]*>([\s\S]*)<\/hc>$/;
const HARNESS_TEXT = /^(<(command-|local-command-|task-notification|bash-)|\[Request interrupted)/;

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === "object") : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((b) => (b.type === "text" ? (str(b.text) ?? "") : b.type === "image" ? "[이미지]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** What the person typed, or null for harness noise. */
function personText(text: string): string | null {
  const clean = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\[Image[^\]]*\]/g, "")
    .trim()
    .replace(HC_NOTE, "$1")
    .trim();
  if (!clean || HARNESS_TEXT.test(clean)) return null;
  return clean;
}

function describeTool(name: string, input: Record<string, unknown>): { summary: string; detail: ToolDetail | null } {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? "";
  switch (name) {
    case "Bash":
      return { summary: firstLine(str(input.command) ?? ""), detail: null };
    case "Read":
      return { summary: path, detail: null };
    case "Write": {
      const added = (str(input.content) ?? "").split("\n");
      return {
        summary: `${path} ${counts({ added: added.length, removed: 0 })}`,
        detail: { type: "diff", text: clipLines(added.map((l) => `+${l}`)) },
      };
    }
    case "Edit": {
      const diff = lineDiff(str(input.old_string) ?? "", str(input.new_string) ?? "");
      return { summary: `${path} ${counts(diff)}`, detail: diffDetail(diff) };
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      const diffs = edits.map((e) => lineDiff(str(e.old_string) ?? "", str(e.new_string) ?? ""));
      const total = diffs.reduce((t, d) => ({ added: t.added + d.added, removed: t.removed + d.removed }), { added: 0, removed: 0 });
      return { summary: `${path} ${counts(total)}`, detail: { type: "diff", text: diffs.map((d) => d.text).join("\n@@\n") } };
    }
    default:
      return { summary: genericSummary(input), detail: null };
  }
}

export function createClaudeParser(): TranscriptParser {
  const pending = new Map<string, ToolEntry>();

  function assistant(uuid: string, at: number, content: unknown): Entry[] {
    const out: Entry[] = [];
    blocks(content).forEach((block, index) => {
      if (block.type === "text") {
        const markdown = (str(block.text) ?? "").trim();
        if (markdown) out.push({ kind: "assistant", id: `${uuid}:${index}`, at, markdown });
      } else if (block.type === "tool_use") {
        const id = str(block.id) ?? `${uuid}:${index}`;
        const name = str(block.name) ?? "tool";
        const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
        const tool: ToolEntry = { kind: "tool", id, at, name, ...describeTool(name, input), ok: null };
        pending.set(id, tool);
        out.push(tool);
      }
    });
    return out;
  }

  function user(uuid: string, at: number, content: unknown): Entry[] {
    const out: Entry[] = [];
    const typed = personText(blocks(content).filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n"));
    if (typed) out.push({ kind: "user", id: uuid, at, text: typed });
    for (const block of blocks(content)) {
      if (block.type !== "tool_result") continue;
      const call = pending.get(str(block.tool_use_id) ?? "");
      if (!call) continue;
      pending.delete(call.id);
      const ok = block.is_error !== true;
      const detail = ok && call.detail ? call.detail : { type: "output" as const, text: clipOutput(textOf(block.content)) };
      out.push({ ...call, ok, detail });
    }
    return out;
  }

  return {
    feed(line) {
      const row = jsonObject(line);
      // isVirtual: calls a REPL script made inside one tool call; the REPL call itself is shown instead.
      if (!row || row.isMeta === true || row.isSidechain === true || row.isVirtual === true || row.isCompactSummary === true) return [];
      const message = row.message as { content?: unknown } | undefined;
      const uuid = str(row.uuid);
      if (!message || !uuid) return [];
      const at = timeOf(row.timestamp);
      if (row.type === "assistant") return assistant(uuid, at, message.content);
      if (row.type === "user") return user(uuid, at, message.content);
      return [];
    },
  };
}
