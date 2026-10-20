import { describe, it, expect } from "vitest";

import { ToolCallAssembler } from "../toolCallAssembler.ts";

/**
 * The assembler is the piece that has to know the three client wire formats.
 * These tests use the EXACT shapes the repo's translators emit:
 *  - `open-sse/translator/response/claude-to-openai.ts` (OpenAI Chat tool_calls)
 *  - `open-sse/translator/response/openai-to-claude.ts` (Anthropic tool_use /
 *    input_json_delta / content_block_stop)
 *  - `open-sse/translator/response/openai-responses.ts` (Responses
 *    output_item.added / function_call_arguments.delta / .done)
 */

describe("ToolCallAssembler", () => {
  describe("OpenAI Chat Completions", () => {
    it("accumulates the argument fragments of one call", () => {
      const assembler = new ToolCallAssembler();

      assembler.consume({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: "" },
                },
              ],
            },
          },
        ],
      });
      assembler.consume({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
      });
      assembler.consume({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
      });

      const info = assembler.consume({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].name).toBe("read_file");
      expect(info.completes[0].callId).toBe("call_1");
      expect(info.completes[0].arguments).toBe('{"path":"a.txt"}');
      expect(info.completes[0].format).toBe("openai");
      expect(info.completes[0].index).toBe(0);
    });

    it("does NOT complete a call before the turn's terminal chunk", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: "{}" } }] },
          },
        ],
      });

      // `{}` is a COMPLETE JSON document — the old parse-based completion check
      // would have completed the call here, on a partial argument set.
      const info = assembler.consume({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }],
      });

      expect(info.completes).toHaveLength(0);
      expect(assembler.pendingCount).toBe(1);
    });

    it("keeps two concurrent calls apart by index", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "a", arguments: "" } }] } },
        ],
      });
      assembler.consume({
        choices: [
          { delta: { tool_calls: [{ index: 1, function: { name: "b", arguments: "" } }] } },
        ],
      });
      assembler.consume({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1" } }] } }],
      });
      assembler.consume({
        choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "2" } }] } }],
      });

      const info = assembler.consume({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });

      expect(info.completes).toHaveLength(2);
      const byName = new Map(info.completes.map((c) => [c.name, c.arguments]));
      expect(byName.get("a")).toBe("1");
      expect(byName.get("b")).toBe("2");
    });

    it("falls back to the call id when no index is present", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        choices: [
          { delta: { tool_calls: [{ id: "call_x", function: { name: "t", arguments: "{}" } }] } },
        ],
      });
      const info = assembler.consume({ choices: [{ delta: {}, finish_reason: "stop" }] });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].callId).toBe("call_x");
    });

    it("reads the non-streaming `message.tool_calls` shape", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        choices: [
          {
            message: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: '{"a":1}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });

      // The `message.tool_calls` shape arrives whole — the finish_reason is in
      // the SAME chunk, so the call must complete from it.
      const assembler2 = new ToolCallAssembler();
      const info = assembler2.consume({
        choices: [
          {
            message: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: '{"a":1}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].arguments).toBe('{"a":1}');
    });
  });

  describe("Anthropic Messages", () => {
    it("accumulates `input_json_delta` fragments and completes on `content_block_stop`", () => {
      const assembler = new ToolCallAssembler();

      assembler.consume({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
      });
      assembler.consume({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      });
      assembler.consume({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
      });

      const mid = assembler.consume({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      });
      expect(mid.completes).toHaveLength(0);

      const info = assembler.consume({ type: "content_block_stop", index: 1 });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].name).toBe("read_file");
      expect(info.completes[0].callId).toBe("toolu_1");
      expect(info.completes[0].format).toBe("anthropic");
      expect(info.completes[0].arguments).toBe('{"path":"a.txt"}{}');
    });

    it("uses the whole `content_block.input` object when the start frame carries it", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_2", name: "t", input: { a: 1 } },
      });
      const info = assembler.consume({ type: "content_block_stop", index: 0 });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].arguments).toBe('{"a":1}');
    });

    it("ignores a text content block", () => {
      const assembler = new ToolCallAssembler();
      const info = assembler.consume({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "hello" },
      });
      expect(info.hasToolContent).toBe(false);
    });

    it("does not complete on a `content_block_stop` for an unknown block", () => {
      const assembler = new ToolCallAssembler();
      const info = assembler.consume({ type: "content_block_stop", index: 7 });
      expect(info.completes).toHaveLength(0);
    });
  });

  describe("OpenAI Responses", () => {
    it("accumulates `function_call_arguments.delta` and completes on `.done`", () => {
      const assembler = new ToolCallAssembler();

      assembler.consume({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_call_1",
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: "",
        },
      });
      assembler.consume({
        type: "response.function_call_arguments.delta",
        item_id: "fc_call_1",
        output_index: 0,
        delta: '{"path":',
      });
      assembler.consume({
        type: "response.function_call_arguments.delta",
        item_id: "fc_call_1",
        output_index: 0,
        delta: '"a.txt"}',
      });

      const mid = assembler.consume({
        type: "response.function_call_arguments.delta",
        item_id: "fc_call_1",
        output_index: 0,
        delta: "",
      });
      expect(mid.completes).toHaveLength(0);

      const info = assembler.consume({
        type: "response.function_call_arguments.done",
        item_id: "fc_call_1",
        output_index: 0,
        arguments: '{"path":"a.txt"}',
      });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].name).toBe("read_file");
      expect(info.completes[0].callId).toBe("call_1");
      expect(info.completes[0].format).toBe("responses");
      expect(info.completes[0].arguments).toBe('{"path":"a.txt"}');
    });

    it("completes on `response.output_item.done`", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_c", type: "function_call", call_id: "c", name: "t", arguments: "" },
      });
      const info = assembler.consume({
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "fc_c", type: "function_call", call_id: "c", name: "t", arguments: '{"a":1}' },
      });

      expect(info.completes).toHaveLength(1);
      expect(info.completes[0].arguments).toBe('{"a":1}');
    });

    it("ignores a message output item", () => {
      const assembler = new ToolCallAssembler();
      const info = assembler.consume({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant" },
      });
      expect(info.hasToolContent).toBe(false);
    });
  });

  describe("cross-format isolation", () => {
    it("does not let an OpenAI index:0 collide with an Anthropic index:0", () => {
      const assembler = new ToolCallAssembler();

      assembler.consume({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: "openai_tool", arguments: "" } }] },
          },
        ],
      });
      assembler.consume({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_0", name: "anthropic_tool", input: {} },
      });

      expect(assembler.pendingCount).toBe(2);
    });
  });

  describe("robustness", () => {
    it("never throws on a non-object payload", () => {
      const assembler = new ToolCallAssembler();
      expect(() => assembler.consume(null)).not.toThrow();
      expect(() => assembler.consume("nope")).not.toThrow();
      expect(() => assembler.consume(42)).not.toThrow();
      expect(() => assembler.consume([])).not.toThrow();
    });

    it("never throws on a malformed tool_calls array", () => {
      const assembler = new ToolCallAssembler();
      expect(() =>
        assembler.consume({
          choices: [{ delta: { tool_calls: [null, 5, "x", { function: null }] } }],
        })
      ).not.toThrow();
    });

    it("flushes in-flight calls through completeAll", () => {
      const assembler = new ToolCallAssembler();
      assembler.consume({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "t", arguments: "{}" } }] } },
        ],
      });
      expect(assembler.hasPending).toBe(true);

      const flushed = assembler.completeAll();
      expect(flushed).toHaveLength(1);
      expect(flushed[0].name).toBe("t");
      expect(assembler.hasPending).toBe(false);
    });

    it("reports the keys a chunk touched, so a caller can suppress them", () => {
      const assembler = new ToolCallAssembler();
      const info = assembler.consume({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "t", arguments: "" } }] } },
        ],
      });
      expect(info.touchedKeys).toHaveLength(1);
      expect(info.touchedKeys[0]).toContain("openai");
    });

    it("reports no touched keys for a frame that belongs to no call", () => {
      const assembler = new ToolCallAssembler();
      const info = assembler.consume({ choices: [{ delta: { content: "hello" } }] });
      expect(info.touchedKeys).toHaveLength(0);
      expect(info.hasToolContent).toBe(false);
    });
  });
});
