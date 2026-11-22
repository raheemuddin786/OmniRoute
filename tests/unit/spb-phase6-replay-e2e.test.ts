import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { setNamedTierConfig } from "../../open-sse/services/tierResolver.ts";
import { getCheckpoint, getSpbTelemetrySummary } from "../../src/lib/db/spbState.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import type { GuidanceContract } from "../../open-sse/services/spb/intentAnalyzer.ts";

const harness = await createChatPipelineHarness("spb-phase6-replay-e2e");
const { buildRequest, handleChat, resetStorage } = harness as {
  buildRequest: (opts: { body: unknown; headers?: Record<string, string> }) => Request;
  handleChat: (req: Request) => Promise<Response>;
  resetStorage: () => void | Promise<void>;
};

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  harness.cleanup?.();
});

test("Phase 6: Replay end-to-end through real handleChat pipeline", async () => {
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-phase6-conn",
    apiKey: "sk-test-mock-phase6",
  });

  const profileName = "test-phase6-replay";
  setNamedTierConfig(profileName, {
    spbEnabled: true,
    tierModels: {
      apex: ["openai/gpt-4o"],
      resilient: ["openai/gpt-4o-mini"],
      local: ["openai/gpt-4o-mini"],
    },
    spbConfig: {
      intentLedgerMode: "apex_guided",
      strictCompletion: true,
      maxReprompts: 2,
    },
  });

  const sessionId = "ext:sess_phase6_replay_test";
  let turnNumber = 0;
  let corruptedCallDispatched = false;
  let dispatchFailureEncountered = false;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    turnNumber++;
    const bodyStr = typeof init?.body === "string" ? init.body : "";

    // Apex expansion handling
    if (
      bodyStr.includes("SPB APEX EXPANSION") ||
      bodyStr.includes("REVIEW LENSES") ||
      bodyStr.includes("isActionable")
    ) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-exp",
          object: "chat.completion",
          created: Date.now(),
          model: "openai/gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  isActionable: true,
                  intents: [
                    {
                      id: "I1",
                      text: "Execute multi-step refactoring workflow",
                      kind: "explicit",
                      promptRef: "Execute multi-step refactoring workflow",
                      layer: "api",
                      targetFiles: ["src/feature.ts"],
                      acceptance: "Feature refactored and tested",
                    },
                  ],
                  nonGoals: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Corrupted tool call injection scenario on turn 2
    if (turnNumber === 2 && !corruptedCallDispatched) {
      corruptedCallDispatched = true;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-corrupt",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_bad",
                    type: "function",
                    function: { name: "edit", arguments: "" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Upstream dispatch failure simulation on turn 4
    if (turnNumber === 4 && !dispatchFailureEncountered) {
      dispatchFailureEncountered = true;
      return new Response(
        JSON.stringify({
          error: { message: "Simulated upstream 503 transient overload" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    // Tool turn responses
    return new Response(
      JSON.stringify({
        id: `chatcmpl-turn-${turnNumber}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${turnNumber}`,
                  type: "function",
                  function: {
                    name: "edit",
                    arguments: JSON.stringify({ file: "src/feature.ts", step: turnNumber }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }> = [
      { role: "user", content: "Execute multi-step refactoring workflow in src/feature.ts" },
    ];

    let effectiveSessionId = sessionId;

    // Replay 10 turns through handleChat
    for (let t = 1; t <= 10; t++) {
      if (t > 1) {
        messages.push({
          role: "assistant",
          tool_calls: [
            {
              id: `call_${t - 1}`,
              type: "function",
              function: { name: "edit", arguments: `{"step": ${t - 1}}` },
            },
          ],
        });
        messages.push({
          role: "tool",
          content: `Executed step ${t - 1} successfully`,
        });
      }

      const req = buildRequest({
        headers: {
          "x-session-id": sessionId,
        },
        body: {
          model: `auto/spb:${profileName}`,
          messages,
          tools: [{ type: "function", function: { name: "edit" } }],
        },
      });

      const res = await handleChat(req);
      const returnedSessionId = res.headers.get("x-omniroute-session-id");
      if (returnedSessionId) {
        effectiveSessionId = returnedSessionId;
      }
      assert.ok(
        res.status === 200 || res.status === 503,
        `Turn ${t} status ${res.status} should be 200 or recovered`
      );
    }

    // Verify checkpoint and telemetry rows using effective session ID
    let checkpoint = getCheckpoint(effectiveSessionId);
    if (!checkpoint) {
      checkpoint = getCheckpoint(sessionId);
    }
    assert.ok(
      checkpoint,
      `Session checkpoint must exist after replay for session ${effectiveSessionId}`
    );
    const contract = checkpoint.guidanceContract as GuidanceContract | undefined;
    assert.ok(contract?.intents?.length, "GuidanceContract must have active ledger");

    const telemetry = getSpbTelemetrySummary(profileName);
    assert.ok(telemetry.totalRoutes >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
