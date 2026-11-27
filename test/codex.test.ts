import { describe, expect, test } from "bun:test";
import { createCodexParser } from "../src/parse/codex.ts";
import { parseAll } from "../src/parse/common.ts";

const T = "2026-11-20T10:00:00.000Z";
const item = (payload: object) => JSON.stringify({ timestamp: T, type: "response_item", payload });
const message = (id: string, role: string, text: string, kinds?: string[]) =>
  item({
    type: "message", id, role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}),
  });

describe("Codex rollout", () => {
  test("typed user text and assistant replies become entries; injected context and developer text do not", () => {
    const entries = parseAll(createCodexParser(), [
      JSON.stringify({ timestamp: T, type: "session_meta", payload: { id: "s1", cwd: "/repo" } }),
      message("m0", "developer", "<permissions>...</permissions>"),
      message("m1", "user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
      message("m2", "user", "# AGENTS.md instructions for /repo\n\nbe brief"),
      message("m3", "user", "<environment_context>x</environment_context>", ["environments.environment_context"]),
      message("m4", "user", "빌드 고쳐줘", ["user.text"]),
      item({ type: "reasoning", id: "r1", summary: [] }),
      message("m5", "assistant", "고쳤습니다."),
      JSON.stringify({ timestamp: T, type: "event_msg", payload: { type: "task_complete", last_agent_message: "고쳤습니다." } }),
    ]);
    expect(entries).toEqual([
      { kind: "user", id: "m4", at: Date.parse(T), text: "빌드 고쳐줘" },
      { kind: "assistant", id: "m5", at: Date.parse(T), markdown: "고쳤습니다." },
    ]);
  });

  test("an apply_patch call shows its files, line counts and the patch as a diff", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " keep",
      "-old",
      "+new",
      "+more",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n");
    const entries = parseAll(createCodexParser(), [
      item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: patch }),
      item({ type: "custom_tool_call_output", call_id: "c1", output: JSON.stringify({ output: "Success", metadata: { exit_code: 0 } }) }),
    ]);
    expect(entries).toEqual([{
      kind: "tool", id: "c1", at: Date.parse(T), name: "apply_patch",
      summary: "src/a.ts, src/b.ts +3 −1",
      detail: { type: "diff", text: "@@ src/a.ts\n@@\n keep\n-old\n+new\n+more\n@@ src/b.ts\n+hello" },
      ok: true,
    }]);
  });

  test("a shell function call shows its command, and a non-zero exit marks it failed", () => {
    const entries = parseAll(createCodexParser(), [
      item({ type: "function_call", call_id: "c2", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"] }) }),
      item({ type: "function_call_output", call_id: "c2", output: JSON.stringify({ output: "1 failing", metadata: { exit_code: 1 } }) }),
    ]);
    expect(entries[0]).toMatchObject({ name: "shell", summary: "npm test", ok: false, detail: { type: "output", text: "1 failing" } });
  });

  test("an exec script call shows the command it runs and its text output", () => {
    const entries = parseAll(createCodexParser(), [
      item({ type: "custom_tool_call", call_id: "c3", name: "exec", input: 'text(await tools.exec_command({cmd:"git status --short"}));' }),
      item({ type: "custom_tool_call_output", call_id: "c3", output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: " M a.ts" }] }),
    ]);
    expect(entries[0]).toMatchObject({ summary: "git status --short", ok: true, detail: { type: "output", text: "Script completed\n M a.ts" } });
  });

  test("plain-text output with an exit code line is read for success", () => {
    const entries = parseAll(createCodexParser(), [
      item({ type: "function_call", call_id: "c4", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) }),
      item({ type: "function_call_output", call_id: "c4", output: "Exit code: 1\nWall time: 0.1 seconds" }),
    ]);
    expect(entries[0]).toMatchObject({ summary: "false", ok: false });
  });
});
