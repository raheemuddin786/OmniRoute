import test from "node:test";
import assert from "node:assert/strict";
import { setTierConfig, getTierConfig } from "../../open-sse/services/tierResolver";
import {
  selectModelTier,
  detectAndRecoverFromStagnation,
} from "../../open-sse/services/spb/tieredRegistry";
import { shouldTriggerZeroLossFallback } from "../../open-sse/services/spb/proxyBridge";
import { evaluateResponseIntent } from "../../open-sse/services/spb/outboundEvaluator";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig";

test.afterEach(() => {
  setTierConfig(DEFAULT_TIER_CONFIG);
});

test("SPB Runtime Config: dynamically updates stagnation threshold at runtime", () => {
  // Default stagnation threshold is 2
  setTierConfig(DEFAULT_TIER_CONFIG);
  const defResult = detectAndRecoverFromStagnation("sess-1", "INSPECTION_SYNTHESIS", 2);
  assert.equal(
    defResult.isStagnant,
    true,
    "Should be stagnant with 2 consecutive reads under default"
  );

  // Update stagnationThreshold to 5
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbConfig: {
      ...DEFAULT_TIER_CONFIG.spbConfig,
      stagnationThreshold: 5,
    },
  });

  const updatedConfig = getTierConfig();
  assert.equal(updatedConfig.spbConfig?.stagnationThreshold, 5);

  const underThreshold = detectAndRecoverFromStagnation("sess-1", "INSPECTION_SYNTHESIS", 2);
  assert.equal(
    underThreshold.isStagnant,
    false,
    "Should NOT be stagnant at 2 reads when threshold is 5"
  );

  const atThreshold = detectAndRecoverFromStagnation("sess-1", "INSPECTION_SYNTHESIS", 5);
  assert.equal(atThreshold.isStagnant, true, "Should be stagnant at 5 reads when threshold is 5");
});

test("SPB Runtime Config: dynamically updates token bounds and tier profiles at runtime", () => {
  // Update token bounds and tier profile for Apex
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbConfig: {
      ...DEFAULT_TIER_CONFIG.spbConfig,
      tokenBounds: {
        apex: { high: 32000, medium: 24000, low: 16000 },
        resilient: { high: 16000, medium: 12000, low: 8000 },
        local: { high: 8000, medium: 4000, low: 2000 },
      },
      tierProfiles: {
        apex: { temperature: 0.7, reasoningEffort: "medium" },
        resilient: { temperature: 0.3, reasoningEffort: "low" },
        local: { temperature: 0.0, reasoningEffort: "low" },
      },
    },
  });

  const assignment = selectModelTier("ARCHITECTURAL_PLANNING", 0.9);
  assert.equal(assignment.tier, "tier_1_apex");
  assert.equal(assignment.maxTokens, 32000, "Should use custom apex high token bound");
  assert.equal(assignment.temperature, 0.7, "Should use custom apex temperature");
  assert.equal(assignment.reasoningEffort, "medium", "Should use custom apex reasoning effort");
});

test("SPB Runtime Config: dynamically updates retry status codes for zero-loss fallback", () => {
  // Under default, 418 is not a fallback trigger
  assert.equal(shouldTriggerZeroLossFallback(418), false);

  // Add 418 to retryStatusCodes
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbConfig: {
      ...DEFAULT_TIER_CONFIG.spbConfig,
      retryStatusCodes: [418, 500, 502],
    },
  });

  assert.equal(
    shouldTriggerZeroLossFallback(418),
    true,
    "418 should trigger fallback when configured"
  );
  assert.equal(
    shouldTriggerZeroLossFallback(429),
    false,
    "429 should not trigger fallback when omitted"
  );
});

test("SPB Runtime Config: dynamically updates minResponseLength for outbound evaluation", () => {
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbConfig: {
      ...DEFAULT_TIER_CONFIG.spbConfig,
      minResponseLength: 10,
    },
  });

  // 12 characters is above 10, so it shouldn't trigger the truncation penalty on length alone
  const evalResult = evaluateResponseIntent(
    "simple prompt",
    [],
    "123456789012",
    "tier_2_resilient",
    "CODE_GENERATION"
  );
  assert.equal(
    evalResult.omissions.some((o) => o.includes("empty, severely truncated")),
    false,
    "Should not flag response above custom minResponseLength"
  );
});
