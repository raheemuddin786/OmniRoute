/**
 * Governance egress transform — the enforcing behaviour of the tap.
 *
 * WHAT THESE TESTS PIN DOWN
 *
 *  1. The tap is a PASS-THROUGH: a stream with no governance signal comes out
 *     byte-identical.
 *  2. The SSE parser is BLOCK-based, so the Anthropic Messages format (whose
 *     frames carry an `event:` line AND a `data:` line) is governed too.
 *  3. A rejected tool call is recorded in the ledger and audited ONCE — and
 *     the rejection is DELIVERED to the model on the NEXT turn's request
 *     (the ingress), because a response stream carries tool CALLS, never tool
 *     RESULTS.
 *  4. A detected loop parks an intervention for the next turn, and escalates
 *     to a CLEAN terminal frame once the intervention budget is spent.
 *  5. A token-sentinel breach terminates the stream with a CLEAN terminal
 *     frame — per client format — not a raw connection drop.
 *  6. Every internal failure fails OPEN (the chunk is forwarded unmodified).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  createGovernanceTransform,
  buildGovernanceTerminalFrames,
  buildGovernanceSteeringFrames,
} from "../governanceTransform.ts";
import { getToolRejectionLedger, buildRejectionKey } from "../toolRejectionLedger.ts";
import { getLoopInterventionStore } from "../loopIntervention.ts";
import { LoopBreaker } from "../loopBreaker.ts";
import { TokenSentinelTracker, type TokenSentinelBreach } from "../tokenSentinel.ts";
import { FORMATS } from "../../translator/formats.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Run a set of SSE frames through the transform and collect the output. */
async function run(chunks: string[], options: Record<string, unknown> = {}): Promise<string> {
  const transform = createGovernanceTransform({
    sessionId: "session-under-test",
    ...options,
  } as never);
  const writer = transform.writable.getWriter();
  const out: string[] = [];
  const reader = transform.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.push(decoder.decode(value));
    }
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  await pump;
  return out.join("");
}

/**
 * Write frames WITHOUT closing the stream, so the transform's mid-stream
 * state can be observed before the flush path runs.
 */
async function runOpen(chunks: string[], options: Record<string, unknown> = {}): Promise<void> {
  const transform = createGovernanceTransform({
    sessionId: "session-under-test",
    ...options,
  } as never);
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  // Let the transform's `transform()` run before the state is inspected.
  await new Promise((resolve) => setTimeout(resolve, 20));
  void pump;
}

/** The request's own tool catalog — only `read_file` is declared. */
const catalog = {
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
};

const OPENAI_CALL_FRAMES = (name: string, callId = "call_1"): string[] => [
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: callId, type: "function", function: { name, arguments: "" } },
          ],
        },
      },
    ],
  })}\n\n`,
  `data: ${JSON.stringify({
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] } },
    ],
  })}\n\n`,
  `data: ${JSON.stringify({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`,
];

const ANTHROPIC_CALL_FRAMES = (name: string, callId = "toolu_1"): string[] => [
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: callId, name, input: {} },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop",
    index: 1,
  })}\n\n`,
];

const RESPONSES_CALL_FRAMES = (name: string, callId = "call_1"): string[] => [
  `event: response.output_item.added\ndata: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: callId, name, arguments: "" },
  })}\n\n`,
  `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "fc_1",
    arguments: '{"path":"a.txt"}',
  })}\n\n`,
];

beforeEach(() => {
  getToolRejectionLedger().clear();
  getLoopInterventionStore().clear();
});

describe("governanceTransform — pass-through", () => {
  it("forwards a plain text stream byte-identical", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const out = await run(frames, { body: catalog });
    expect(out).toBe(frames.join(""));
  });

  it("forwards `event:` lines and comments untouched", async () => {
    const frames = [
      ": keepalive\n\n",
      'event: ping\ndata: {"a":1}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const out = await run(frames, { body: catalog });
    expect(out).toBe(frames.join(""));
  });

  it("forwards a frame whose payload is not JSON untouched", async () => {
    const frames = ["data: not-json-at-all\n\n"];
    const out = await run(frames, { body: catalog });
    expect(out).toBe(frames.join(""));
  });

  it("reassembles a frame split across two chunks", async () => {
    const whole = 'data: {"choices":[{"delta":{"content":"split"}}]}\n\n';
    const out = await run([whole.slice(0, 20), whole.slice(20)], { body: catalog });
    expect(out).toBe(whole);
  });

  it("forwards a truncated trailing frame on flush", async () => {
    const out = await run(['data: {"partial":1}\n'], { body: catalog });
    expect(out).toBe('data: {"partial":1}\n');
  });
});

describe("governanceTransform — tool-call rejection", () => {
  it("records an OpenAI rejection in the ledger", async () => {
    await run(OPENAI_CALL_FRAMES("nope_tool"), { body: catalog });
    const entry = getToolRejectionLedger().get(buildRejectionKey("session-under-test", "call_1"));
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe("nope_tool");
    expect(entry?.reason).toBe("unknown_tool");
    expect(entry?.audited).toBe(true);
  });

  it("records an Anthropic rejection in the ledger", async () => {
    await run(ANTHROPIC_CALL_FRAMES("nope_tool"), {
      body: catalog,
      clientFormat: FORMATS.CLAUDE,
    });
    const entry = getToolRejectionLedger().get(buildRejectionKey("session-under-test", "toolu_1"));
    expect(entry?.name).toBe("nope_tool");
    expect(entry?.reason).toBe("unknown_tool");
  });

  it("records a Responses rejection in the ledger", async () => {
    await run(RESPONSES_CALL_FRAMES("nope_tool"), {
      body: catalog,
      clientFormat: FORMATS.OPENAI_RESPONSES,
    });
    const entry = getToolRejectionLedger().get(buildRejectionKey("session-under-test", "call_1"));
    expect(entry?.name).toBe("nope_tool");
    expect(entry?.reason).toBe("unknown_tool");
  });

  it("does NOT record a rejection for a declared tool", async () => {
    await run(OPENAI_CALL_FRAMES("read_file"), { body: catalog });
    expect(getToolRejectionLedger().size).toBe(0);
  });

  it("rejects a declared tool whose arguments violate its schema", async () => {
    // `path` is required by the catalog schema; the call omits it.
    const frames = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad",
                  type: "function",
                  function: { name: "read_file", arguments: "" },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
    ];
    await run(frames, { body: catalog });
    const entry = getToolRejectionLedger().get(buildRejectionKey("session-under-test", "call_bad"));
    expect(entry?.reason).toBe("invalid_arguments");
  });

  it("does not validate a call before the turn's terminal marker", async () => {
    // The name arrives, the arguments are still streaming — no terminal marker
    // yet, so nothing may be judged. The stream stays OPEN, so the flush path
    // (which completes a truncated call) does not run either.
    await runOpen(
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_partial",
                    type: "function",
                    function: { name: "nope_tool", arguments: "" },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      ],
      { body: catalog }
    );
    expect(getToolRejectionLedger().size).toBe(0);
  });

  it("completes a truncated call on flush and judges it", async () => {
    // The upstream ended without a terminal marker. The accumulated arguments
    // are the best available approximation of the complete call, so the flush
    // path judges it rather than letting it escape.
    await run(
      [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_truncated",
                    type: "function",
                    function: { name: "nope_tool", arguments: "" },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      ],
      { body: catalog }
    );
    expect(
      getToolRejectionLedger().get(buildRejectionKey("session-under-test", "call_truncated"))
        ?.reason
    ).toBe("unknown_tool");
  });

  it("audits a rejected call exactly once even when it is seen twice", async () => {
    const frames = OPENAI_CALL_FRAMES("nope_tool");
    await run([...frames, ...frames], { body: catalog });
    const ledger = getToolRejectionLedger();
    expect(ledger.size).toBe(1);
    expect(ledger.get(buildRejectionKey("session-under-test", "call_1"))?.audited).toBe(true);
  });

  it("preserves the client's bytes — the tap never rewrites a rejected call", async () => {
    const frames = OPENAI_CALL_FRAMES("nope_tool");
    const out = await run(frames, { body: catalog });
    expect(out).toBe(frames.join(""));
  });
});

describe("governanceTransform — loop breaker", () => {
  it("parks an intervention for the next turn", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 3, maxInterventions: 2 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    for (let i = 0; i < 3; i++) {
      await run(OPENAI_CALL_FRAMES("read_file"), {
        body: catalog,
        loopBreaker,
      });
    }

    const parked = getLoopInterventionStore().peek("session-under-test");
    expect(parked).not.toBeNull();
    expect(parked).toContain("read_file");
  });

  it("steers the agent in-stream with clean finish reason for Anthropic client without error frames", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 1, maxInterventions: 1 });
    const aborted: unknown[] = [];
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    let out = "";
    for (let i = 0; i < 3; i++) {
      out = await run(ANTHROPIC_CALL_FRAMES("read_file"), {
        body: catalog,
        loopBreaker,
        clientFormat: FORMATS.CLAUDE,
        onLoopAbort: (detection: unknown) => aborted.push(detection),
      });
    }

    expect(aborted.length).toBeGreaterThan(0);
    expect(out).toContain("content_block_delta");
    expect(out).toContain("Governance Steering Directive");
    expect(out).toContain("end_turn");
    expect(out).toContain("message_stop");
    expect(out).not.toContain("event: error");
  });

  it("falls back to legacy error frames when steering is explicitly disabled", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 1, maxInterventions: 1 });
    const aborted: unknown[] = [];
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    let out = "";
    for (let i = 0; i < 3; i++) {
      out = await run(ANTHROPIC_CALL_FRAMES("read_file"), {
        body: catalog,
        loopBreaker,
        clientFormat: FORMATS.CLAUDE,
        enableSteering: false,
        onLoopAbort: (detection: unknown) => aborted.push(detection),
      });
    }

    expect(aborted.length).toBeGreaterThan(0);
    expect(out).toContain("event: error");
    expect(out).toContain("governance_loop_aborted");
  });

  it("does not park an intervention when the loop breaker sees no loop", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 99 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;
    await run(OPENAI_CALL_FRAMES("read_file"), { body: catalog, loopBreaker });
    expect(getLoopInterventionStore().peek("session-under-test")).toBeNull();
  });
});

describe("governanceTransform — token sentinel", () => {
  it("terminates the stream with a clean OpenAI terminal frame on breach", async () => {
    const tracker = new TokenSentinelTracker({ ceiling: 10 });
    const breaches: unknown[] = [];
    const out = await run(
      [
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: "x".repeat(80) } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "never seen" } }],
        })}\n\n`,
      ],
      {
        body: catalog,
        clientFormat: FORMATS.OPENAI,
        tokenTracker: tracker,
        onBreach: (breach: unknown) => breaches.push(breach),
      }
    );

    expect(breaches.length).toBe(1);
    expect(out).toContain("governance");
    expect(out).toContain("[DONE]");
    // The content AFTER the breach is never forwarded.
    expect(out).not.toContain("never seen");
  });

  it("terminates the stream with a clean Anthropic terminal frame on breach", async () => {
    const tracker = new TokenSentinelTracker({ ceiling: 10 });
    const out = await run(
      [
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "x".repeat(80) },
        })}\n\n`,
      ],
      {
        body: catalog,
        clientFormat: FORMATS.CLAUDE,
        tokenTracker: tracker,
      }
    );

    expect(out).toContain("event: error");
    expect(out).toContain("message_stop");
  });
});

describe("buildGovernanceTerminalFrames", () => {
  it("emits an OpenAI Chat terminal pair", () => {
    const frames = buildGovernanceTerminalFrames(FORMATS.OPENAI, "stopped", "ceiling");
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("finish_reason");
    expect(text).toContain("[DONE]");
    expect(text).toContain("governance_limit");
  });

  it("emits an Anthropic terminal pair", () => {
    const frames = buildGovernanceTerminalFrames(FORMATS.CLAUDE, "stopped", "loop");
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("event: error");
    expect(text).toContain("message_stop");
    expect(text).toContain("governance_loop_aborted");
  });

  it("emits a Responses terminal pair", () => {
    const frames = buildGovernanceTerminalFrames(FORMATS.OPENAI_RESPONSES, "stopped", "ceiling");
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("response.failed");
    expect(text).toContain("sequence_number");
    expect(text).toContain("[DONE]");
  });

  it("never leaks a stack trace into the terminal frames", () => {
    const frames = buildGovernanceTerminalFrames(
      FORMATS.OPENAI,
      "Error: boom\n    at /secret/path.ts:1:1",
      "ceiling"
    );
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).not.toContain("at /secret/path.ts");
  });
});

describe("buildGovernanceSteeringFrames", () => {
  it("emits Anthropic steering frames with end_turn and text content block", () => {
    const frames = buildGovernanceSteeringFrames(
      FORMATS.CLAUDE,
      "[Governance Steering Directive: Change strategy]",
      { hasSeenMessageStart: true, openAnthropicBlockIndex: 0, highestAnthropicBlockIndex: 0 }
    );
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("content_block_stop");
    expect(text).toContain("content_block_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("[Governance Steering Directive: Change strategy]");
    expect(text).toContain("end_turn");
    expect(text).toContain("message_stop");
    expect(text).not.toContain("event: error");
  });

  it("emits Anthropic steering frames starting with message_start when not yet seen", () => {
    const frames = buildGovernanceSteeringFrames(
      FORMATS.CLAUDE,
      "[Governance Steering Directive: Change strategy]",
      { hasSeenMessageStart: false }
    );
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("event: message_start");
    expect(text).toContain("end_turn");
    expect(text).not.toContain("event: error");
  });

  it("emits OpenAI Chat steering frames with assistant delta and normal stop finish_reason", () => {
    const frames = buildGovernanceSteeringFrames(
      FORMATS.OPENAI,
      "[Governance Steering Directive: Change strategy]"
    );
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("assistant");
    expect(text).toContain("[Governance Steering Directive: Change strategy]");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"error":');
  });

  it("emits Responses steering frames with completed status and output text", () => {
    const frames = buildGovernanceSteeringFrames(
      FORMATS.OPENAI_RESPONSES,
      "[Governance Steering Directive: Change strategy]"
    );
    const text = frames.map((f) => decoder.decode(f)).join("");
    expect(text).toContain("response.output_item.added");
    expect(text).toContain("response.text.delta");
    expect(text).toContain("[Governance Steering Directive: Change strategy]");
    expect(text).toContain("response.output_item.done");
    expect(text).toContain("response.completed");
    expect(text).toContain('"status":"completed"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("response.failed");
  });
});

describe("governanceTransform — false-positive avoidance", () => {
  it("does NOT trip on three similar-but-DISTINCT calls to the same tool", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 3, maxInterventions: 2 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    // Three calls to the SAME tool, each with a materially different argument.
    const distinct = ['{"path":"a.txt"}', '{"path":"b.txt"}', '{"path":"c.txt"}'];
    for (const args of distinct) {
      await run(
        [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_x",
                      type: "function",
                      function: { name: "read_file", arguments: "" },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        ],
        { body: catalog, loopBreaker }
      );
    }

    expect(getLoopInterventionStore().peek("session-under-test")).toBeNull();
    expect(breaker.getInterventionCount("session-under-test")).toBe(0);
  });

  it("does NOT trip on three calls to three DIFFERENT tools with the same arguments", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 3, maxInterventions: 2 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    for (const name of ["a_tool", "b_tool", "c_tool"]) {
      await run(
        [
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_x",
                      type: "function",
                      function: { name, arguments: '{"p":1}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        ],
        { body: catalog, loopBreaker }
      );
    }

    expect(getLoopInterventionStore().peek("session-under-test")).toBeNull();
  });

  it("trips on three IDENTICAL calls to the same tool", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 3, maxInterventions: 2 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;

    for (let i = 0; i < 3; i++) {
      await run(OPENAI_CALL_FRAMES("read_file"), { body: catalog, loopBreaker });
    }

    expect(breaker.getInterventionCount("session-under-test")).toBe(1);
  });
});

describe("governanceTransform — fail open", () => {
  it("forwards the chunk unmodified when the tool catalog getter throws", async () => {
    // A hostile body must not break the stream: the validation fails, the
    // governance tap logs it, and the bytes go out untouched.
    const hostile = {
      get tools(): never {
        throw new Error("boom");
      },
    };
    const frames = OPENAI_CALL_FRAMES("read_file");
    const out = await run(frames, { body: hostile });
    expect(out).toBe(frames.join(""));
  });

  it("forwards the chunk unmodified when the loop breaker throws", async () => {
    const loopBreaker = {
      observe: () => {
        throw new Error("breaker exploded");
      },
    } as never;
    const frames = OPENAI_CALL_FRAMES("read_file");
    const out = await run(frames, { body: catalog, loopBreaker });
    expect(out).toBe(frames.join(""));
  });

  it("forwards the chunk unmodified when the onBreach callback throws", async () => {
    const tracker = new TokenSentinelTracker({ ceiling: 10 });
    const out = await run(
      [
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: "x".repeat(80) } }],
        })}\n\n`,
      ],
      {
        body: catalog,
        clientFormat: FORMATS.OPENAI,
        tokenTracker: tracker,
        onBreach: () => {
          throw new Error("callback exploded");
        },
      }
    );
    // The terminal frames are still emitted — the callback failure must not
    // leave the stream without a clean finish.
    expect(out).toContain("[DONE]");
  });

  it("aborts when rejected/malformed tool calls are repeatedly emitted", async () => {
    const breaker = new LoopBreaker({ repeatThreshold: 2, maxInterventions: 1 });
    const loopBreaker = { observe: breaker.observe.bind(breaker) } as never;
    const aborted: unknown[] = [];

    // Emit an unknown tool call twice (which fails schema validation / rejection)
    let out = "";
    for (let i = 0; i < 3; i++) {
      out = await run(OPENAI_CALL_FRAMES("unknown_hallucinated_tool", '{"bad":1}'), {
        body: catalog,
        loopBreaker,
        clientFormat: FORMATS.OPENAI,
        onLoopAbort: (detection: unknown) => aborted.push(detection),
      });
    }

    expect(aborted.length).toBeGreaterThan(0);
    expect(out).toContain("governance");
    expect(out).toContain("finish_reason");
  });

  it("terminates stream with loop finish reason on degenerate repetitive generation", async () => {
    const tracker = new TokenSentinelTracker({ ceiling: 10000 });
    const breaches: TokenSentinelBreach[] = [];
    const stutterText =
      "Google's Google's recommended recommended snippet snippet is is always always ";
    const out = await run(
      [
        `data: ${JSON.stringify({
          choices: [{ delta: { content: stutterText } }],
        })}\n\n`,
      ],
      {
        body: catalog,
        clientFormat: FORMATS.OPENAI,
        tokenTracker: tracker,
        onBreach: (b: TokenSentinelBreach) => breaches.push(b),
      }
    );

    expect(breaches.length).toBe(1);
    expect(breaches[0].kind).toBe("repetition");
    expect(out).toContain("governance");
    expect(out).toContain("[DONE]");
  });
});
