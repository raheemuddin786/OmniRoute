import test from "node:test";
import assert from "node:assert/strict";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
import { detectAndRecoverFromStagnation } from "../../open-sse/services/spb/tieredRegistry.ts";
import {
  judgeCompletion,
  type MechanicalEvidence,
} from "../../open-sse/services/spb/apexLedger.ts";
import { setNamedTierConfig } from "../../open-sse/services/tierResolver.ts";
import { saveCheckpoint } from "../../src/lib/db/spbState.ts";
import type { IntentLedgerItem } from "../../open-sse/services/spb/intentAnalyzer.ts";

test("Phase 4: Turn 1 injects full checklist directive; later turns get compact one-line status", async () => {
  const profileName = "test-phase4-directives";
  setNamedTierConfig(profileName, {
    spbEnabled: true,
    tierModels: {
      apex: ["openai/gpt-4o"],
      resilient: ["openai/gpt-4o-mini"],
      local: ["openai/gpt-4o-mini"],
    },
    spbConfig: {
      intentLedgerMode: "apex_guided",
      maxLedgerItems: 8,
    },
  });

  const sessionId = "sess_phase4_directives_test";
  const intents: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Build feature A",
      kind: "explicit",
      promptRef: "Build feature A in src/feature.ts",
      layer: "api",
      acceptance: "Returns 200 OK",
      status: "open",
    },
  ];

  const mockDispatch = async () =>
    JSON.stringify({
      isActionable: true,
      intents,
      nonGoals: [],
    });

  // Turn 1: Initial request with no prior checkpoint
  const turn1Result = await processSmartProxyRouting({
    sessionId,
    spbProfile: profileName,
    messages: [{ role: "user", content: "Build feature A in src/feature.ts" }],
    dispatchModel: mockDispatch,
  });

  const turn1Content = turn1Result.enhancedMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  assert.match(
    turn1Content,
    /SPB-IR Intent Checklist & Scope Fence: 0\/1 Complete/,
    "Turn 1 must inject the full checklist directive"
  );
  assert.match(turn1Content, /Mandatory Guidelines:/);

  // Turn 2: Follow-up turn with established checkpoint
  saveCheckpoint({
    sessionId,
    promptAnchorHash: "hash_" + sessionId,
    modelTier: "tier_1_apex",
    taskPhase: "CODE_GENERATION",
    guidanceContract: {
      intents,
    },
    createdAt: Date.now(),
    timestamp: Date.now(),
  });

  const turn2Result = await processSmartProxyRouting({
    sessionId,
    spbProfile: profileName,
    messages: [
      { role: "user", content: "Build feature A in src/feature.ts" },
      { role: "assistant", content: "I am ready." },
      { role: "user", content: "Go ahead and edit the file." },
    ],
    dispatchModel: mockDispatch,
  });

  const turn2Content = turn2Result.enhancedMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  assert.match(
    turn2Content,
    /\[SPB Intent Ledger: 0\/1 Complete \| Active: I1/,
    "Later turns must receive a compact one-line status"
  );
  assert.doesNotMatch(
    turn2Content,
    /Mandatory Guidelines:/,
    "Later turns must NOT repeat the full checklist directive"
  );
});

test("Phase 4: Stagnation guard removes negative prohibition wording", () => {
  const result = detectAndRecoverFromStagnation("sess_stagnation_test", "CODE_GENERATION", 3);
  assert.equal(result.isStagnant, true);
  assert.ok(result.recoveryDirective);
  // Verify negative prohibition wording like "DO NOT", "STOP", "FORBIDDEN" is removed
  assert.doesNotMatch(
    result.recoveryDirective,
    /\b(?:do not|stop|forbidden|prohibited|never)\b/i,
    "Stagnation guard recoveryDirective must not contain negative prohibition phrasing"
  );
  assert.match(
    result.recoveryDirective,
    /\b(?:Proceed|implement|execute|Exploration checkpoint)\b/i,
    "Stagnation guard must provide constructive affirmative forward execution directives"
  );
});

test("Phase 4: Judge receives diffs of modified test files", async () => {
  const testPatch =
    "--- a/tests/unit/example.test.ts\n+++ b/tests/unit/example.test.ts\n@@ -10,3 +10,4 @@\n+  assert.equal(res.status, 200);\n";

  const evidence: MechanicalEvidence = {
    diffDelta: {
      files: ["src/app.ts", "tests/unit/example.test.ts"],
      hashes: { "src/app.ts": "h1", "tests/unit/example.test.ts": "h2" },
      patch: testPatch,
    },
    testCommands: [{ command: "npm test", exitCode: 0 }],
    observedReadFiles: ["src/app.ts"],
    observedWrittenFiles: ["src/app.ts", "tests/unit/example.test.ts"],
    diffVisible: true,
  };

  let receivedPayload: string = "";
  const mockJudgeDispatch = async (payload: {
    messages: Array<{ role: string; content: string }>;
  }) => {
    receivedPayload = payload.messages.map((m) => m.content).join("\n");
    return JSON.stringify({
      items: [{ id: "I1", status: "done", evidence: "Tests pass" }],
      outOfScopeFiles: [],
      reprompt: "",
      isSatisfied: true,
    });
  };

  await judgeCompletion(
    [
      {
        id: "I1",
        text: "Add test assertion",
        kind: "explicit",
        layer: "test",
        acceptance: "Tests pass with 200",
        status: "open",
      },
    ],
    evidence,
    "I have implemented the test.",
    mockJudgeDispatch
  );

  assert.ok(receivedPayload.length > 0);
  assert.match(
    receivedPayload,
    /tests\/unit\/example\.test\.ts/,
    "Judge payload must include modified test files"
  );
  assert.match(
    receivedPayload,
    /assert\.equal\(res\.status, 200\)/,
    "Judge payload must include test patch diffs"
  );
});
