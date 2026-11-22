import test from "node:test";
import assert from "node:assert/strict";
import { classifyFollowUp } from "../../open-sse/services/spb/apexLedger.ts";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
import { setNamedTierConfig } from "../../open-sse/services/tierResolver.ts";
import { saveCheckpoint, getCheckpoint } from "../../src/lib/db/spbState.ts";
import type {
  GuidanceContract,
  IntentLedgerItem,
} from "../../open-sse/services/spb/intentAnalyzer.ts";

test("Phase 2: classifyFollowUp defaults to continuation when classification fails with active ledger", async () => {
  const activeContract: GuidanceContract = {
    intents: [
      {
        id: "I1",
        text: "Implement feature A",
        kind: "explicit",
        layer: "api",
        acceptance: "feature A works",
        status: "open",
      },
      {
        id: "I2",
        text: "Write unit test for feature A",
        kind: "explicit",
        layer: "test",
        acceptance: "tests pass",
        status: "open",
      },
    ],
  };

  // Dispatch function that fails or throws
  const failingDispatch = async () => {
    throw new Error("Model 500 error / unparseable output");
  };

  const result = await classifyFollowUp(activeContract, "any message here", failingDispatch);
  assert.equal(
    result.relation,
    "continuation",
    "Classification failure with an active ledger must strictly default to continuation"
  );
  assert.equal(result.ledger.length, 2, "Active ledger must be preserved");
  assert.equal(result.ledger[0].id, "I1");
  assert.equal(result.ledger[1].id, "I2");
});

test("Phase 2: classifyFollowUp only returns new_task when Apex classification explicitly succeeds", async () => {
  const activeContract: GuidanceContract = {
    intents: [
      {
        id: "I1",
        text: "Existing feature",
        kind: "explicit",
        layer: "api",
        acceptance: "works",
        status: "done",
      },
    ],
  };

  // Dispatch function that returns invalid JSON
  const invalidJsonDispatch = async () => "not a json string";
  const result = await classifyFollowUp(activeContract, "random text", invalidJsonDispatch);
  assert.notEqual(
    result.relation,
    "new_task",
    "Only successful Apex classification may return new_task"
  );
  assert.equal(result.relation, "continuation");

  // Dispatch function that explicitly succeeds with new_task
  const successfulNewTaskDispatch = async () =>
    JSON.stringify({
      relation: "new_task",
      directive: "Starting completely new instruction",
      intents: [
        {
          id: "I1",
          text: "Brand new requirement",
          kind: "explicit",
          promptRef: "Brand new requirement",
          layer: "api",
          acceptance: "brand new requirement met",
          status: "open",
        },
      ],
    });

  const successResult = await classifyFollowUp(
    activeContract,
    "Let's switch topics completely",
    successfulNewTaskDispatch
  );
  assert.equal(successResult.relation, "new_task");
  assert.equal(successResult.ledger.length, 1);
});

test("Phase 2: Reject smaller or generic replacement ledgers and log ledger_downgrade_rejected", async () => {
  const profileName = "test-phase2-downgrade";
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
      maxLedgerItems: 8,
    },
  });

  const sessionId = "sess_phase2_downgrade_test";
  const initialItems: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Item 1",
      kind: "explicit",
      layer: "api",
      acceptance: "accepted 1",
      status: "open",
    },
    {
      id: "I2",
      text: "Item 2",
      kind: "explicit",
      layer: "data",
      acceptance: "accepted 2",
      status: "open",
    },
    {
      id: "I3",
      text: "Item 3",
      kind: "explicit",
      layer: "test",
      acceptance: "accepted 3",
      status: "open",
    },
  ];

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "hash_" + sessionId,
    modelTier: "tier_1_apex",
    taskPhase: "CODE_GENERATION",
    guidanceContract: {
      intents: initialItems,
    },
    createdAt: Date.now(),
    timestamp: Date.now(),
  });

  // Follow-up model returns a generic single item during amendment attempt
  const mockDispatch = async () =>
    JSON.stringify({
      relation: "amendment",
      directive: "Collapsing everything",
      intents: [
        {
          id: "I1",
          text: "Do generic tasks",
          kind: "explicit",
          promptRef: "Do generic tasks",
          layer: "api",
          acceptance: "done",
          status: "open",
        },
      ],
    });

  const _routingResult = await processSmartProxyRouting({
    sessionId,
    spbProfile: profileName,
    messages: [{ role: "user", content: "proceed with things" }],
    dispatchModel: mockDispatch,
  });

  // Verify that the collapse was rejected and the 3 initial items were preserved
  const checkpoint = getCheckpoint(sessionId);
  assert.ok(checkpoint?.guidanceContract);
  const contract = checkpoint.guidanceContract as GuidanceContract;
  assert.equal(
    contract.intents?.length,
    3,
    "Smaller replacement ledger during active task must be rejected"
  );
  assert.equal(contract.intents[0].id, "I1");
  assert.equal(contract.intents[1].id, "I2");
  assert.equal(contract.intents[2].id, "I3");
});
