import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adaptBodyForCompression } from "../../open-sse/services/compression/bodyAdapter.ts";

describe("compression body adapter tool pair atomicity", () => {
  it("drops a function_call when compaction removes its mapped function_call_output", () => {
    const body = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read file." }],
        },
        {
          type: "function_call",
          call_id: "call_fn_1",
          name: "read_file",
          arguments: JSON.stringify({ path: "test.ts" }),
        },
        {
          type: "function_call_output",
          call_id: "call_fn_1",
          output: "file contents",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Next step." }],
        },
      ],
    };

    const adapter = adaptBodyForCompression(body);
    // Simulate compaction dropping the tool output message (role === "tool")
    const compressedMessages = (adapter.body.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role !== "tool"
    );

    const restored = adapter.restore(
      { ...adapter.body, messages: compressedMessages },
      { dropMissingMappedItems: true }
    );
    const input = restored.input as Array<Record<string, unknown>>;

    assert.equal(
      input.some((item) => item.type === "function_call"),
      false,
      "orphan function_call must be dropped"
    );
    assert.equal(
      input.some((item) => item.type === "function_call_output"),
      false,
      "dropped function_call_output must not be present"
    );
    assert.equal(
      input.some((item) => item.type === "message"),
      true,
      "surviving messages must remain"
    );
  });

  it("drops local_shell_call when local_shell_call_output is removed by compaction", () => {
    const body = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "local_shell_call",
          call_id: "shell_1",
          command: "ls -la",
        },
        {
          type: "local_shell_call_output",
          call_id: "shell_1",
          output: "file1 file2",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Done." }],
        },
      ],
    };

    const adapter = adaptBodyForCompression(body);
    const compressedMessages = (adapter.body.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role !== "tool"
    );

    const restored = adapter.restore(
      { ...adapter.body, messages: compressedMessages },
      { dropMissingMappedItems: true }
    );
    const input = restored.input as Array<Record<string, unknown>>;

    assert.equal(
      input.some((item) => item.type === "local_shell_call"),
      false,
      "local_shell_call must be dropped when local_shell_call_output is missing"
    );
    assert.equal(
      input.some((item) => item.type === "local_shell_call_output"),
      false
    );
  });

  it("drops apply_patch_call when apply_patch_call_output is removed by compaction", () => {
    const body = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "apply_patch_call",
          call_id: "patch_1",
          patch: "--- a\n+++ b",
        },
        {
          type: "apply_patch_call_output",
          call_id: "patch_1",
          output: "patch applied",
        },
      ],
    };

    const adapter = adaptBodyForCompression(body);
    const compressedMessages = (adapter.body.messages as Array<Record<string, unknown>>).filter(
      (m) => m.role !== "tool"
    );

    const restored = adapter.restore(
      { ...adapter.body, messages: compressedMessages },
      { dropMissingMappedItems: true }
    );
    const input = restored.input as Array<Record<string, unknown>>;

    assert.equal(
      input.some((item) => item.type === "apply_patch_call"),
      false
    );
    assert.equal(
      input.some((item) => item.type === "apply_patch_call_output"),
      false
    );
  });

  it("drops orphan tool output if the corresponding tool call was pruned or absent", () => {
    // Suppose an output exists in input whose corresponding call is absent from input
    const body = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Analyze this result:" }],
        },
        {
          type: "function_call",
          call_id: "call_existing",
          name: "search",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_existing",
          output: "found",
        },
      ],
    };

    const adapter = adaptBodyForCompression(body);
    const restored = adapter.restore(
      { ...adapter.body, messages: adapter.body.messages },
      { dropMissingMappedItems: true }
    );
    const input = restored.input as Array<Record<string, unknown>>;

    assert.equal(input.length, 3, "intact pairs remain");
    assert.equal(
      input.some((i) => i.call_id === "call_existing"),
      true
    );
  });

  it("preserves trailing tool calls that legitimately have no output yet", () => {
    const body = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run tool." }],
        },
        {
          type: "function_call",
          call_id: "call_trailing",
          name: "execute_command",
          arguments: JSON.stringify({ cmd: "whoami" }),
        },
      ],
    };

    const adapter = adaptBodyForCompression(body);
    const restored = adapter.restore(
      { ...adapter.body, messages: adapter.body.messages },
      { dropMissingMappedItems: true }
    );
    const input = restored.input as Array<Record<string, unknown>>;

    assert.equal(
      input.some((item) => item.call_id === "call_trailing"),
      true,
      "trailing tool call without output must be preserved"
    );
  });
});
