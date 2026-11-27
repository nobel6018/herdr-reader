// Codex rollout lines (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) to entries. Pure.
// @see docs/herdr-reader.md

import type { Entry, ToolDetail } from "../types.ts";
import { type TranscriptParser, clipLines, clipOutput, counts, firstLine, genericSummary, jsonObject, str, timeOf } from "./common.ts";

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** Context codex injects as a user message: one tag block such as <environment_context>…</environment_context>. */
const INJECTED = /^(<([a-z_]+)[\s>][\s\S]*<\/\2>|# AGENTS\.md instructions)/;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" ? (str((c as { text?: unknown }).text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function typedByPerson(payload: Record<string, unknown>, text: string): boolean {
  const meta = payload.internal_chat_message_metadata_passthrough as { content_item_kinds?: unknown } | undefined;
  if (Array.isArray(meta?.content_item_kinds)) return meta.content_item_kinds.includes("user.text");
  return !INJECTED.test(text.trim());
}

export function describePatch(patch: string): { summary: string; detail: ToolDetail } {
  const paths: string[] = [];
  const body: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (file?.[1]) {
      paths.push(file[1].trim());
      body.push(`@@ ${file[1].trim()}`);
    } else if (line.startsWith("*** ")) {
      continue;
    } else {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      body.push(line);
    }
  }
  return { summary: `${paths.join(", ")} ${counts({ added, removed })}`, detail: { type: "diff", text: clipLines(body) } };
}

function describeTool(name: string, input: unknown): { summary: string; detail: ToolDetail | null } {
  const args = typeof input === "string" ? (jsonObject(input) ?? input) : input;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const patch = name === "apply_patch" ? (typeof args === "string" ? args : str(record?.input)) : null;
  if (patch) return describePatch(patch);
  if (Array.isArray(record?.command)) return { summary: firstLine(String(record.command.at(-1) ?? "")), detail: null };
  if (typeof args === "string") {
    const cmd = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(args);
    return { summary: firstLine(cmd?.[2] ?? args), detail: null };
  }
  return { summary: genericSummary(record), detail: null };
}

function outputOf(output: unknown): { text: string; ok: boolean } {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // plain text output
    }
  }
  if (Array.isArray(value)) value = contentText(value);
  let ok = true;
  if (value && typeof value === "object") {
    const record = value as { output?: unknown; metadata?: { exit_code?: unknown } };
    if (typeof record.metadata?.exit_code === "number") ok = record.metadata.exit_code === 0;
    value = str(record.output) ?? JSON.stringify(value);
  }
  const text = typeof value === "string" ? value : String(value ?? "");
  const exit = /^(?:Exit code|Process exited with code):? (\d+)/m.exec(text);
  if (exit) ok = exit[1] === "0";
  if (/^Script (failed|error)/i.test(text)) ok = false;
  return { text, ok };
}

export function createCodexParser(): TranscriptParser {
  const pending = new Map<string, ToolEntry>();

  return {
    feed(line) {
      const row = jsonObject(line);
      if (!row || row.type !== "response_item") return [];
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload) return [];
      const at = timeOf(row.timestamp);
      const id = str(payload.id) ?? `${str(row.timestamp) ?? ""}:${str(payload.type) ?? ""}`;

      switch (payload.type) {
        case "message": {
          const text = contentText(payload.content).trim();
          if (!text) return [];
          if (payload.role === "assistant") return [{ kind: "assistant", id, at, markdown: text }];
          if (payload.role === "user" && typedByPerson(payload, text)) return [{ kind: "user", id, at, text }];
          return [];
        }
        case "custom_tool_call":
        case "function_call": {
          const callId = str(payload.call_id) ?? id;
          const name = str(payload.name) ?? "tool";
          const tool: ToolEntry = { kind: "tool", id: callId, at, name, ...describeTool(name, payload.input ?? payload.arguments), ok: null };
          pending.set(callId, tool);
          return [tool];
        }
        case "custom_tool_call_output":
        case "function_call_output": {
          const call = pending.get(str(payload.call_id) ?? "");
          if (!call) return [];
          pending.delete(call.id);
          const { text, ok } = outputOf(payload.output);
          const detail = ok && call.detail ? call.detail : { type: "output" as const, text: clipOutput(text) };
          return [{ ...call, ok, detail }];
        }
        default:
          return [];
      }
    },
  };
}
