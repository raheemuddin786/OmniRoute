import { test } from "node:test";
import assert from "node:assert/strict";

import { getTierConfig, setTierConfig } from "../../open-sse/services/tierResolver.ts";
import {
  resolveAutoRoutingState,
  createVirtualAutoCombo,
} from "../../src/sse/handlers/autoRouting.ts";

test("SPB Fallback Ladder: tierConfig provides configured tier models across all tiers", () => {
  setTierConfig({
    version: "1.0.0",
    defaults: { freeThreshold: 0, cheapThreshold: 1 },
    providerOverrides: [],
    modelOverrides: [],
    freeProviders: [],
    spbEnabled: true,
    tierModels: {
      apex: ["apex/claude-sonnet-5.5", "claude-sonnet-5"],
      resilient: ["antigravity/gemini-3.8-flash-tiered", "claude-opus-4-9"],
      local: ["nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "antigravity/gemini-3.1-flash-lite"],
    },
  });

  const config = getTierConfig();
  assert.equal(config.spbEnabled, true);
  assert.deepEqual(config.tierModels?.apex, ["apex/claude-sonnet-5.5", "claude-sonnet-5"]);
  assert.deepEqual(config.tierModels?.resilient, [
    "antigravity/gemini-3.8-flash-tiered",
    "claude-opus-4-9",
  ]);
  assert.deepEqual(config.tierModels?.local, [
    "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
    "antigravity/gemini-3.1-flash-lite",
  ]);
});

test("SPB Virtual Auto-Combo Guard: returns 503 when SPB unconfigured (no tier models or SPB disabled)", async () => {
  // Test case 1: SPB disabled - should return 503
  setTierConfig({
    version: "1.0.0",
    defaults: { freeThreshold: 0, cheapThreshold: 1 },
    providerOverrides: [],
    modelOverrides: [],
    freeProviders: [],
    spbEnabled: false,
    tierModels: {
      apex: [],
      resilient: [],
      local: [],
    },
  });
  const autoRoutingDisabled = await resolveAutoRoutingState("auto/spb");
  const resultDisabled = await createVirtualAutoCombo(autoRoutingDisabled, null);
  assert.ok(resultDisabled instanceof Response, "must return error response when SPB disabled");
  assert.equal(resultDisabled.status, 503);

  // Test case 2: SPB enabled but no tier models configured - should return 503
  setTierConfig({
    version: "1.0.0",
    defaults: { freeThreshold: 0, cheapThreshold: 1 },
    providerOverrides: [],
    modelOverrides: [],
    freeProviders: [],
    spbEnabled: true,
    tierModels: {
      apex: [],
      resilient: [],
      local: [],
    },
  });
  const autoRoutingNoModels = await resolveAutoRoutingState("auto/spb");
  const resultNoModels = await createVirtualAutoCombo(autoRoutingNoModels, null);
  assert.ok(resultNoModels instanceof Response, "must return error response when no tier models");
  assert.equal(resultNoModels.status, 503);

  // Test case 3: SPB enabled WITH tier models configured - should succeed (no 503)
  setTierConfig({
    version: "1.0.0",
    defaults: { freeThreshold: 0, cheapThreshold: 1 },
    providerOverrides: [],
    modelOverrides: [],
    freeProviders: [],
    spbEnabled: true,
    tierModels: {
      apex: ["apex/claude-sonnet-5.5", "claude-sonnet-5"],
      resilient: ["antigravity/gemini-3.8-flash-tiered", "claude-opus-4-9"],
      local: ["nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "antigravity/gemini-3.1-flash-lite"],
    },
  });

  const autoRoutingConfigured = await resolveAutoRoutingState("auto/spb");
  const resultConfigured = await createVirtualAutoCombo(autoRoutingConfigured, null);
  // When configured, should NOT return 503; should return a valid combo
  assert.ok(
    !(resultConfigured instanceof Response) || resultConfigured.status !== 503,
    "should not return 503 when SPB is enabled with tier models configured"
  );
});
