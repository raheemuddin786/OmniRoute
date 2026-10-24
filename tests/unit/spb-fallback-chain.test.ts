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

test("SPB Virtual Auto-Combo Guard: returns 503 instead of falling through to generic 500+ model pool when unconfigured", async () => {
  const autoRouting = await resolveAutoRoutingState("auto/spb");
  assert.equal(autoRouting.isAutoRouting, true);

  // When no spbCombo was formed (null), createVirtualAutoCombo must NOT create a 500+ model pool
  const result = await createVirtualAutoCombo(autoRouting, null);
  assert.ok(result instanceof Response, "must return error response");
  assert.equal(result.status, 503);
  const json = await result.json();
  assert.match(json.error?.message || json.message, /No models configured for auto\/spb/);
});
