import test from "node:test";
import assert from "node:assert/strict";
import {
  hasCorruptedToolCalls,
  getNextFailoverTier,
} from "../../open-sse/services/spb/proxyBridge.ts";
import { processSpbOutboundZeroLoss } from "../../open-sse/services/spb/outboundEvaluator.ts";
import { setNamedTierConfig } from "../../open-sse/services/tierResolver.ts";
import { saveCheckpoint, getCheckpoint } from "../../src/lib/db/spbState.ts";
import type { GuidanceContract } from "../../open-sse/services/spb/intentAnalyzer.ts";

test("Phase 3: hasCorruptedToolCalls detects empty arguments or malformed JSON", () => {
  // Empty arguments
  const emptyArgs = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "edit", arguments: "" },
            },
          ],
        },
      },
    ],
  };
  assert.equal(hasCorruptedToolCalls(emptyArgs), true);

  // Whitespace arguments
  const whitespaceArgs = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "bash", arguments: "   " },
            },
          ],
        },
      },
    ],
  };
  assert.equal(hasCorruptedToolCalls(whitespaceArgs), true);

  // Malformed unparseable JSON arguments
  const malformedArgs = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_3",
              type: "function",
              function: { name: "write", arguments: '{"file": "test.txt", "content": ' },
            },
          ],
        },
      },
    ],
  };
  assert.equal(hasCorruptedToolCalls(malformedArgs), true);

  // Valid tool call
  const validCall = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_4",
              type: "function",
              function: { name: "write", arguments: '{"file": "test.txt", "content": "hello"}' },
            },
          ],
        },
      },
    ],
  };
  assert.equal(hasCorruptedToolCalls(validCall), false);
});

test("Phase 3: getNextFailoverTier advances local -> resilient -> apex", () => {
  assert.equal(getNextFailoverTier("tier_3_local"), "tier_2_resilient");
  assert.equal(getNextFailoverTier("tier_2_resilient"), "tier_1_apex");
  assert.equal(getNextFailoverTier("tier_1_apex"), "tier_1_apex");
});

test("Phase 3: processSpbOutboundZeroLoss fails over tier on corrupted tool call without consuming standard reprompts", async () => {
  const profileName = "test-phase3-corrupted";
  setNamedTierConfig(profileName, {
    spbEnabled: true,
    tierModels: {
      apex: ["openai/gpt-4o"],
      resilient: ["openai/gpt-4o-mini"],
      local: ["openai/gpt-4o-mini"],
    },
    spbConfig: {
      intentLedgerMode: "apex_guided",
      maxReprompts: 2,
    },
  });

  const sessionId = "sess_phase3_corrupted_test";
  const initialResponse = new Response(
    JSON.stringify({
      id: "chatcmpl-corrupt",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "bash", arguments: "" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );

  let failoverDispatched = false;
  let dispatchedBody: Record<string, unknown> | null = null;

  const mockDispatch = async (newBody: Record<string, unknown>) => {
    failoverDispatched = true;
    dispatchedBody = newBody;
    return new Response(
      JSON.stringify({
        id: "chatcmpl-fixed",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_good",
                  type: "function",
                  function: { name: "bash", arguments: '{"command": "echo success"}' },
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

  const finalRes = await processSpbOutboundZeroLoss({
    initialResponse,
    dispatchModel: mockDispatch,
    body: {
      messages: [{ role: "user", content: "run tests" }],
      tools: [{ type: "function", function: { name: "bash" } }],
    },
    originalPrompt: "run tests",
    preservedIntentions: [],
    tier: "tier_3_local",
    taskPhase: "TESTING_AND_VERIFICATION",
    sessionId,
    maxReprompts: 2,
    spbProfile: profileName,
  });

  assert.equal(finalRes.status, 200);
  assert.equal(failoverDispatched, true, "Tier promotion must dispatch request to next tier");
  assert.equal(
    dispatchedBody?._spbTierPromotion,
    "tier_2_resilient",
    "Tier must be promoted from tier_3_local to tier_2_resilient"
  );
  // Header reprompt count must NOT be incremented because tier promotion does not consume user reprompt count
  assert.equal(finalRes.headers.get("X-OmniRoute-SPB-Reprompt-Count"), "0");
});

test("Phase 3: 2 zero-progress turns escalate tier once, then block and report summary rather than repeating reprompt", async () => {
  const profileName = "test-phase3-stagnation";
  setNamedTierConfig(profileName, {
    spbEnabled: true,
    tierModels: {
      apex: ["openai/gpt-4o"],
      resilient: ["openai/gpt-4o-mini"],
      local: ["openai/gpt-4o-mini"],
    },
    spbConfig: {
      intentLedgerMode: "apex_guided",
      maxReprompts: 3,
    },
  });

  const sessionId = "sess_phase3_zero_prog_test";
  saveCheckpoint({
    sessionId,
    promptAnchorHash: "hash_" + sessionId,
    modelTier: "tier_2_resilient",
    taskPhase: "CODE_GENERATION",
    guidanceContract: {
      intents: [
        {
          id: "I1",
          text: "Perform code modification",
          kind: "explicit",
          layer: "api",
          acceptance: "modified",
          status: "open",
        },
      ],
    },
    createdAt: Date.now(),
    timestamp: Date.now(),
  });

  const zeroProgressResponse = new Response(
    JSON.stringify({
      id: "chatcmpl-talk",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I am thinking about how to solve this problem without tools.",
          },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

  let dispatchCalls = 0;
  const repromptTexts: string[] = [];

  const mockDispatch = async (newBody: Record<string, unknown>) => {
    dispatchCalls++;
    const msgs = (newBody.messages || []) as Array<{ role: string; content: string }>;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && typeof lastMsg.content === "string") {
      repromptTexts.push(lastMsg.content);
    }

    // Always return text only without tools or diff
    return new Response(
      JSON.stringify({
        id: `chatcmpl-talk-${dispatchCalls}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `Still merely thinking ${dispatchCalls}...`,
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const finalRes = await processSpbOutboundZeroLoss({
    initialResponse: zeroProgressResponse,
    dispatchModel: mockDispatch,
    body: {
      messages: [{ role: "user", content: "implement code" }],
      tools: [{ type: "function", function: { name: "write" } }],
    },
    originalPrompt: "implement code",
    preservedIntentions: [],
    tier: "tier_2_resilient",
    taskPhase: "CODE_GENERATION",
    sessionId,
    maxReprompts: 3,
    spbProfile: profileName,
  });

  assert.equal(finalRes.status, 200);
  // Verify that identical reprompts are never sent
  const set = new Set(repromptTexts);
  assert.equal(set.size, repromptTexts.length, "Never repeat the exact same reprompt text");

  // Check that open items were marked blocked and completion report was generated
  const checkpoint = getCheckpoint(sessionId);
  assert.ok(checkpoint?.guidanceContract);
  const contract = checkpoint.guidanceContract as GuidanceContract;
  assert.equal(contract.intents?.[0]?.status, "blocked");

  const jsonBody = (await finalRes.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const finalContent = jsonBody.choices?.[0]?.message?.content || "";
  assert.match(finalContent, /SPB INTENT LEDGER.*COMPLETION SUMMARY|STATUS REPORT|Blocked/i);
});
