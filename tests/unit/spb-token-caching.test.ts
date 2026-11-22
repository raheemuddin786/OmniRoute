import test from "node:test";
import assert from "node:assert/strict";
import {
  saveCheckpoint,
  getCheckpoint,
  initSpbStateTable,
  __resetSpbStateInitForTests,
  type SpbStateCheckpoint,
} from "../../src/lib/db/spbState";
import { resetDbInstance } from "../../src/lib/db/core";
import { selectModelTier } from "../../open-sse/services/spb/tieredRegistry";
import {
  processSmartProxyRouting,
  shouldTriggerZeroLossFallback,
} from "../../open-sse/services/spb/proxyBridge";
import {
  registerCooldownBlock,
  inspectErrorResponse,
  clearAllGlobalCooldowns,
} from "../../open-sse/services/globalRateLimiter";

test.beforeEach(() => {
  resetDbInstance();
  __resetSpbStateInitForTests();
  initSpbStateTable();
  clearAllGlobalCooldowns();
});

test.afterEach(() => {
  resetDbInstance();
  clearAllGlobalCooldowns();
});

test("SPB Checkpoint Memory Cache: stores and retrieves from in-memory cache instantly", () => {
  const sessionId = "sess_cache_test_" + Date.now();
  const checkpoint: SpbStateCheckpoint = {
    sessionId,
    promptAnchorHash: "hash_abc_123",
    taskPhase: "ARCHITECTURAL_PLANNING",
    modelTier: "tier_1_apex",
    statePayload: JSON.stringify({ step: 1 }),
    createdAt: Date.now(),
  };

  const saved = saveCheckpoint(checkpoint);
  assert.equal(saved, true);

  // In-memory retrieval
  const retrieved = getCheckpoint(sessionId);
  assert.ok(retrieved);
  assert.equal(retrieved.sessionId, sessionId);
  assert.equal(retrieved.promptAnchorHash, "hash_abc_123");
  assert.equal(retrieved.modelTier, "tier_1_apex");
});

test("SPB Tier Selection: dynamically modulates token limits by complexityScore", () => {
  // High complexity -> full token budget
  const highTier = selectModelTier("ARCHITECTURAL_PLANNING", 0.9);
  assert.equal(highTier.tier, "tier_1_apex");
  assert.equal(highTier.maxTokens, 16384);

  // Low complexity -> conservative token budget to save tokens
  const lowTier = selectModelTier("ARCHITECTURAL_PLANNING", 0.2);
  assert.equal(lowTier.tier, "tier_1_apex");
  assert.equal(lowTier.maxTokens, 8192);

  // Tier 2 Resilient modulated
  const resHigh = selectModelTier("CODE_GENERATION", 0.85);
  assert.equal(resHigh.maxTokens, 8192);

  const resLow = selectModelTier("CODE_GENERATION", 0.1);
  assert.equal(resLow.maxTokens, 4096);
});

test("SPB Tier Selection: prioritizes healthy models over models in cooldown", () => {
  const customModels = {
    apex: ["anthropic/claude-3-7-sonnet", "openai/o3-mini"],
    resilient: ["anthropic/claude-3-5-sonnet", "openai/gpt-4o"],
    local: ["ollama/llama-3.2", "meta/llama-3.1-8b"],
  };

  // Put anthropic/claude-3-7-sonnet in cooldown
  const inspection = inspectErrorResponse({
    status: 429,
    errorBody: "Rate limit exceeded",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
  });
  registerCooldownBlock({
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    inspection,
  });

  const assignment = selectModelTier("ARCHITECTURAL_PLANNING", 0.5, customModels);
  assert.equal(assignment.tier, "tier_1_apex");
  // The healthy model openai/o3-mini should be prioritized first
  assert.equal(assignment.recommendedModels[0], "openai/o3-mini");
});

test("SPB Routing: injects prompt cache control and calculates tokens saved on large payloads", async () => {
  const sessionId = "spb_cache_token_test_" + Date.now();
  const largeContent = "console.log('padding to reach 1200+ characters');\n".repeat(40);

  const decision = await processSmartProxyRouting({
    sessionId,
    messages: [
      { role: "system", content: "You are an autonomous architect." },
      { role: "user", content: "Analyze this code:\n" + largeContent },
    ],
    tools: [{ type: "function", function: { name: "test_tool", parameters: {} } }],
  });

  assert.ok(decision);
  assert.ok(decision.tierAssignment);
  if (decision.tierAssignment.cacheEnabled) {
    assert.deepEqual(decision.cacheControl, { type: "ephemeral" });
  }

  // Verify enhancedMessages has cache_control on system or preceding turns
  if (decision.enhancedMessages) {
    const sysMsg = decision.enhancedMessages.find((m) => m.role === "system");
    if (sysMsg && decision.tierAssignment.cacheEnabled) {
      assert.deepEqual((sysMsg as Record<string, unknown>).cache_control, { type: "ephemeral" });
    }
  }

  // Tokens saved should be non-negative
  assert.equal(typeof decision.tokensSaved, "number");
  assert.ok((decision.tokensSaved ?? 0) >= 0);
});

test("SPB Zero-Loss Fallback: triggers on 409 conflict and 529 overload", () => {
  assert.equal(shouldTriggerZeroLossFallback(409), true);
  assert.equal(shouldTriggerZeroLossFallback(529), true);
  assert.equal(shouldTriggerZeroLossFallback(429), true);
  assert.equal(shouldTriggerZeroLossFallback(503), true);
  assert.equal(shouldTriggerZeroLossFallback(200), false);
});
