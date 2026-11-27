// Helpers shared by the transcript parsers. Pure functions.
// @see docs/herdr-reader.md

import type { Entry, ToolDetail } from "../types.ts";

/** Turns one transcript line at a time into entries. feed returns the entries that are new or changed. */
export interface TranscriptParser {
  feed(line: string): Entry[];
}

const OUTPUT_CHARS = 8_000;
const DIFF_LINES = 400;

export function parseAll(parser: TranscriptParser, lines: Iterable<string>): Entry[] {
  const byId = new Map<string, Entry>();
  for (const line of lines) for (const entry of parser.feed(line)) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function jsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function timeOf(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

export function clipOutput(text: string): string {
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n... (${text.length - OUTPUT_CHARS}자 생략)` : text;
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function lines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

export interface Diff {
  text: string;
  added: number;
  removed: number;
}

/** A unified-ish diff of two snippets: shared head and tail lines as context, the middle as removed then added. */
export function lineDiff(before: string, after: string): Diff {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const out = [
    ...a.slice(Math.max(0, head - 2), head).map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...a.slice(a.length - tail, a.length - tail + 2).map((l) => ` ${l}`),
  ];
  return { text: clipLines(out), added: added.length, removed: removed.length };
}

export function clipLines(out: string[]): string {
  if (out.length <= DIFF_LINES) return out.join("\n");
  return [...out.slice(0, DIFF_LINES), `... (${out.length - DIFF_LINES}줄 생략)`].join("\n");
}

export function diffDetail(diff: Diff): ToolDetail {
  return { type: "diff", text: diff.text };
}

export function counts(diff: { added: number; removed: number }): string {
  return `+${diff.added} −${diff.removed}`;
}

/** A one-line description of a tool call for tools without a dedicated summary. */
export function genericSummary(input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["description", "command", "cmd", "file_path", "path", "pattern", "url", "query", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return firstLine(value);
  }
  for (const value of Object.values(record)) if (typeof value === "string" && value.trim()) return firstLine(value);
  return "";
}
