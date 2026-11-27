import { describe, expect, test } from "bun:test";
import { createClaudeParser } from "../src/parse/claude.ts";
import { parseAll } from "../src/parse/common.ts";

const T = "2026-11-20T10:00:00.000Z";
const line = (row: object) => JSON.stringify({ timestamp: T, ...row });
const user = (uuid: string, content: unknown, extra: object = {}) => line({ type: "user", uuid, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[], extra: object = {}) => line({ type: "assistant", uuid, message: { role: "assistant", content }, ...extra });

describe("Claude Code transcript", () => {
  test("a typed message and a text reply become a user and an assistant entry", () => {
    const entries = parseAll(createClaudeParser(), [
      user("u1", "테스트 돌려줘"),
      assistant("a1", [{ type: "thinking", thinking: "hidden" }]),
      assistant("a2", [{ type: "text", text: "**통과**했습니다." }]),
    ]);
    expect(entries).toEqual([
      { kind: "user", id: "u1", at: Date.parse(T), text: "테스트 돌려줘" },
      { kind: "assistant", id: "a2:0", at: Date.parse(T), markdown: "**통과**했습니다." },
    ]);
  });

  test("harness text, meta, sidechain, virtual and compact-summary rows are left out", () => {
    const entries = parseAll(createClaudeParser(), [
      user("u1", "<command-name>/clear</command-name>"),
      user("u2", "<local-command-stdout>ok</local-command-stdout>"),
      user("u3", "<task-notification>done</task-notification>"),
      user("u4", [{ type: "text", text: "<system-reminder>be nice</system-reminder>" }]),
      user("u5", "hidden", { isMeta: true }),
      assistant("a1", [{ type: "text", text: "subagent" }], { isSidechain: true }),
      assistant("a2", [{ type: "tool_use", id: "v1", name: "Bash", input: { command: "ls" } }], { isVirtual: true }),
      user("u6", "This session is being continued", { isCompactSummary: true }),
      "not json",
      "",
    ]);
    expect(entries).toEqual([]);
  });

  test("a system reminder inside a typed message is stripped and the rest kept", () => {
    const [entry] = parseAll(createClaudeParser(), [user("u1", [{ type: "text", text: "<system-reminder>x</system-reminder>\n배포해줘" }])]);
    expect(entry).toMatchObject({ kind: "user", text: "배포해줘" });
  });

  test("a Bash call shows its command and pairs with its result by id", () => {
    const entries = parseAll(createClaudeParser(), [
      assistant("a1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "bun test\necho done" } }]),
      user("u1", [{ type: "tool_result", tool_use_id: "toolu_1", content: "3 pass\n0 fail" }]),
    ]);
    expect(entries).toEqual([
      { kind: "tool", id: "toolu_1", at: Date.parse(T), name: "Bash", summary: "bun test", detail: { type: "output", text: "3 pass\n0 fail" }, ok: true },
    ]);
  });

  test("an error result marks the call failed", () => {
    const entries = parseAll(createClaudeParser(), [
      assistant("a1", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/missing.ts" } }]),
      user("u1", [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: [{ type: "text", text: "File does not exist." }] }]),
    ]);
    expect(entries[0]).toMatchObject({ summary: "/repo/missing.ts", ok: false, detail: { type: "output", text: "File does not exist." } });
  });

  test("feed reports the call when it starts and again when its result arrives", () => {
    const parser = createClaudeParser();
    expect(parser.feed(assistant("a1", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]))).toMatchObject([{ id: "toolu_1", ok: null }]);
    expect(parser.feed(user("u1", [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.ts" }]))).toMatchObject([{ id: "toolu_1", ok: true }]);
  });

  test("an Edit shows path, line counts and a diff of the changed lines", () => {
    const entries = parseAll(createClaudeParser(), [
      assistant("a1", [{
        type: "tool_use", id: "toolu_1", name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: "one\ntwo\nthree", new_string: "one\nTWO\n2b\nthree" },
      }]),
      user("u1", [{ type: "tool_result", tool_use_id: "toolu_1", content: "updated" }]),
    ]);
    expect(entries[0]).toMatchObject({
      name: "Edit",
      summary: "/repo/a.ts +2 −1",
      ok: true,
      detail: { type: "diff", text: " one\n-two\n+TWO\n+2b\n three" },
    });
  });

  test("a result whose call fell outside the read window is dropped", () => {
    expect(parseAll(createClaudeParser(), [user("u1", [{ type: "tool_result", tool_use_id: "gone", content: "x" }])])).toEqual([]);
  });
});
