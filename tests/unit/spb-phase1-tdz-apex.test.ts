import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";
import { setNamedTierConfig } from "../../open-sse/services/tierResolver.ts";
import { getCheckpoint } from "../../src/lib/db/spbState.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import type { GuidanceContract } from "../../open-sse/services/spb/intentAnalyzer.ts";

const harness = await createChatPipelineHarness("spb-phase1-tdz-apex");
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

test("Phase 1: handleChat runs Apex expansion without TDZ or heuristic fallback", async () => {
  // Create an active credential connection for openai so dispatch succeeds
  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-test-conn",
    apiKey: "sk-test-mock-key-phase1",
  });

  const profileName = "test-phase1-apex";
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

  const sessionId = "ext:sess_phase1_apex_test";
  const userPrompt =
    "Refactor database migration in src/lib/db/users.ts and add test in tests/users.test.ts";

  const originalFetch = globalThis.fetch;
  let apexExpansionDispatched = false;

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const bodyStr = typeof init?.body === "string" ? init.body : "";

    // Check if this is the Apex expansion dispatch or the main chat execution
    if (
      bodyStr.includes("SPB APEX EXPANSION") ||
      bodyStr.includes("intents") ||
      bodyStr.includes("actionable requirements") ||
      bodyStr.includes("isActionable")
    ) {
      apexExpansionDispatched = true;
      const expansionPayload = {
        id: "chatcmpl-apex-exp",
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
                    text: "Refactor database migration in src/lib/db/users.ts",
                    kind: "explicit",
                    promptRef: "Refactor database migration in src/lib/db/users.ts",
                    layer: "data",
                    targetFiles: ["src/lib/db/users.ts"],
                    acceptance: "Migration code refactored cleanly",
                  },
                  {
                    id: "I2",
                    text: "Add unit test in tests/users.test.ts",
                    kind: "explicit",
                    promptRef: "add test in tests/users.test.ts",
                    layer: "test",
                    targetFiles: ["tests/users.test.ts"],
                    acceptance: "Unit test covers user migration",
                  },
                ],
                nonGoals: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      };
      return new Response(JSON.stringify(expansionPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default mock response for regular model execution
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: "openai/gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I have reviewed the files and ready to begin.",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  try {
    const req = buildRequest({
      headers: {
        "x-session-id": sessionId,
      },
      body: {
        model: `auto/spb:${profileName}`,
        messages: [{ role: "user", content: userPrompt }],
      },
    });

    const res = await handleChat(req);
    assert.equal(res.status, 200);
    assert.equal(apexExpansionDispatched, true, "Apex expansion must be dispatched");

    // Extract session id returned in response header or look up effective session
    const returnedSessionId = res.headers.get("x-omniroute-session-id") || sessionId;
    const checkpoint = getCheckpoint(returnedSessionId) || getCheckpoint(sessionId);
    assert.ok(checkpoint, `Session checkpoint must exist for ${returnedSessionId}`);
    const contract = checkpoint.guidanceContract as GuidanceContract | undefined;
    assert.ok(contract, "GuidanceContract must be established");
    assert.equal(contract.intents?.length, 2, "Apex expansion must populate the 2 intents");
    assert.equal(contract.intents[0].id, "I1");
    assert.equal(contract.intents[1].id, "I2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
