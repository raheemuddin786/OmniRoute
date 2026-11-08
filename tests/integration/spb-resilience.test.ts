import test from "node:test";
import assert from "node:assert/strict";
import {
  processSmartProxyRouting,
  shouldTriggerZeroLossFallback,
} from "../../open-sse/services/spb/proxyBridge.ts";
import {
  saveCheckpoint,
  getCheckpoint,
  __resetSpbStateInitForTests,
} from "../../src/lib/db/spbState.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { saveTierConfig } from "../../src/lib/db/tierConfig.ts";
import { setTierConfig } from "../../open-sse/services/tierResolver.ts";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig.ts";

const testTierConfig = {
  ...DEFAULT_TIER_CONFIG,
  spbEnabled: true,
  tierModels: {
    apex: ["test-resilience-apex-1", "test-resilience-apex-2"],
    resilient: ["test-resilience-resilient-1"],
    local: ["test-resilience-local-1"],
  },
};

test.before(() => {
  saveTierConfig(testTierConfig);
  setTierConfig(testTierConfig);
});

// Close the DB handle after all tests so the native test runner does not hang.
test.after(() => {
  __resetSpbStateInitForTests();
  resetDbInstance();
});

test("SPB Integration: Zero-loss resilience and state resumption across mock failover", async () => {
  const sessionId = "integration_session_" + Date.now();
  const messages = [
    { role: "system", content: "You are an autonomous engineering agent." },
    {
      role: "user",
      content:
        "Implement a fault-tolerant circuit breaker in TypeScript with class and async methods.",
    },
  ];

  // 1. Initial routing decision & checkpoint creation
  const decision1 = await processSmartProxyRouting({ sessionId, messages });
  assert.equal(decision1.intent.taskPhase, "CODE_GENERATION");
  assert.equal(decision1.checkpointRestored, false);

  // 2. Simulate upstream failure (e.g. HTTP 503 or 429)
  const failedStatusCode = 503;
  assert.equal(shouldTriggerZeroLossFallback(failedStatusCode), true);

  // 3. Explicitly save and verify checkpoint state before recovery
  const testCheckpoint = {
    sessionId,
    promptAnchorHash: decision1.intent.promptAnchorHash,
    taskPhase: decision1.intent.taskPhase,
    modelTier: decision1.tierAssignment.tier,
    statePayload: JSON.stringify({ recovered: true, turn: 2 }),
    createdAt: Date.now(),
  };
  saveCheckpoint(testCheckpoint);

  const checkpoint = getCheckpoint(sessionId);
  assert.notEqual(checkpoint, null);
  assert.equal(checkpoint?.promptAnchorHash, decision1.intent.promptAnchorHash);
  assert.match(checkpoint?.statePayload ?? "", /recovered/);

  // 4. Simulate fallback request execution with restored session state
  const decision2 = await processSmartProxyRouting({ sessionId, messages });
  assert.equal(decision2.intent.promptAnchorHash, decision1.intent.promptAnchorHash);
  assert.equal(decision2.checkpointRestored, true);
});

test("SPB Integration: 'auto' model resolves through SPB tiered routing with priority fallback roster", async () => {
  const sessionId = "auto_dispatch_session_" + Date.now();
  const messages = [
    {
      role: "user",
      content: "Architect a high-performance consensus algorithm with Raft and Paxos comparison.",
    },
  ];

  const decision = await processSmartProxyRouting({ sessionId, messages });
  assert.equal(decision.intent.taskPhase, "ARCHITECTURAL_PLANNING");
  assert.equal(decision.tierAssignment.tier, "tier_1_apex");
  assert.ok(decision.tierAssignment.recommendedModels.length > 0);

  // Verify that the tier roster contains the user-configured models for apex tier
  const tierModels = decision.tierAssignment.recommendedModels;
  assert.deepEqual(tierModels, ["test-resilience-apex-1", "test-resilience-apex-2"]);
});

test("SPB Integration: 'auto' directive is protected from model aliases and resolves as virtual combo", async () => {
  const { resolveModelAliasWithSeedFallback } = await import("../../src/lib/modelAliasResolver.ts");
  const { getModelInfo } = await import("../../src/sse/services/model.ts");

  const resolved = await resolveModelAliasWithSeedFallback("auto");
  assert.equal(resolved, "auto");

  const modelInfo = await getModelInfo("auto");
  assert.equal(modelInfo.provider, "auto");
  assert.notEqual((modelInfo as { errorType?: string }).errorType, "model_not_found");
});

test("SPB Integration: 'auto/spb' and 'auto/smart-proxy-bridge' are recognized transparent auto combos", async () => {
  const { AUTO_TEMPLATE_VARIANTS, isRecognizedBuiltinAuto } =
    await import("../../open-sse/services/autoCombo/builtinCatalog.ts");

  assert.equal(Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, "auto/spb"), true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, "auto/smart-proxy-bridge"),
    true
  );
  assert.equal(isRecognizedBuiltinAuto("auto/spb", "spb"), true);
  assert.equal(isRecognizedBuiltinAuto("auto/smart-proxy-bridge", "smart-proxy-bridge"), true);
});

test("SPB Integration: bare 'spb' is not exposed as a valid model name", async () => {
  const { AUTO_TEMPLATE_VARIANTS, isRecognizedBuiltinAuto } =
    await import("../../open-sse/services/autoCombo/builtinCatalog.ts");
  const { getModelInfo } = await import("../../src/sse/services/model.ts");

  assert.equal(Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, "spb"), false);
  assert.equal(isRecognizedBuiltinAuto("spb", "spb"), false);

  const modelInfo = await getModelInfo("spb");
  assert.equal((modelInfo as { errorType?: string }).errorType, "model_not_found");
});

test("SPB Integration: SPB dynamic combo is isolated from generic context cache pinning", async () => {
  const { phaseComboSetup } = await import("../../open-sse/services/combo/comboSetup.ts");
  const { createComboContext } = await import("../../open-sse/services/combo/context.ts");
  const { recordSessionModelUsage } = await import("../../src/lib/db/contextHandoffs.ts");

  const sessionId = "spb_isolation_session_" + Date.now();
  const spbCombo = {
    id: "spb-tier_2_resilient",
    name: "SPB tier_2_resilient",
    type: "spb" as const,
    strategy: "priority" as const,
    models: [{ model: "resilient-primary" }, { model: "resilient-secondary" }],
  };

  // 1. Simulate a previous leaf model recording in session_model_history
  recordSessionModelUsage(sessionId, spbCombo.name, "pinned-leaf-model", "test-provider");

  // 2. Initialize combo setup with SPB active payload
  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const ctx = createComboContext({
    body: {
      model: "auto/spb",
      messages: [{ role: "user", content: "Implement a feature" }],
      _spbActive: true,
      _spbDecision: {
        selectedModel: "resilient-primary",
        tierAssignment: { tier: "tier_2_resilient" },
      },
    },
    combo: spbCombo,
    settings: null,
    relayOptions: { sessionId },
    log: mockLogger,
  });

  const setup = phaseComboSetup(ctx);

  // 3. Verify that SPB dynamic combos do NOT engage generic context cache pinning
  assert.equal(setup.pinnedModel, null);
  assert.equal(setup.effectiveSessionId, null);
  // Request body model remains unchanged by generic combo pin
  assert.equal(ctx.body.model, "auto/spb");
});
