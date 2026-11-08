import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFreeModelTier,
  discoverAvailableFreeTierModels,
  resolveTierCandidateModels,
  isFreeModelTarget,
} from "../../open-sse/services/spbFreeTierAutoConfig.ts";

describe("SPB Free Tier Auto-Config", () => {
  it("verifies paid models are rejected and free models are recognized by isFreeModelTarget", () => {
    // Explicit paid models must always return false
    assert.equal(isFreeModelTarget("openai/gpt-4o"), false);
    assert.equal(isFreeModelTarget("anthropic/claude-3-5-sonnet"), false);
    assert.equal(isFreeModelTarget("cohere/command-r"), false);

    // Free models from catalog / zero pricing must return true
    assert.equal(isFreeModelTarget("duckduckgo-web/gpt-5.4-mini"), true);
    assert.equal(isFreeModelTarget("agentrouter/claude-opus-4-8"), true);
  });

  it("classifies free models into apex, resilient, and local based on capabilities and suffixes", () => {
    assert.equal(classifyFreeModelTier("deepseek-r1", "openrouter"), "apex");
    assert.equal(classifyFreeModelTier("qwen-2.5-coder-32b", "openrouter"), "apex");
    assert.equal(classifyFreeModelTier("gemini-1.5-flash-8b", "google"), "local");
    assert.equal(classifyFreeModelTier("llama-3.2-3b-instruct", "groq"), "local");
    assert.equal(classifyFreeModelTier("gemini-2.5-flash", "google"), "resilient");
  });

  it("discovers active free models without crashing or returning invalid entries", () => {
    const discovered = discoverAvailableFreeTierModels();
    assert.ok(Array.isArray(discovered));
    assert.ok(discovered.length > 0, "should discover cataloged free models");
    for (const m of discovered.slice(0, 10)) {
      assert.ok(m.provider);
      assert.ok(m.model);
      assert.ok(["apex", "resilient", "local"].includes(m.tier));
    }
  });

  it("resolves tier candidate models based on mode (free, user, both)", () => {
    const configured = ["custom-provider/user-model-1"];

    // User only mode
    const userOnly = resolveTierCandidateModels("apex", configured, {
      tierMode: "user",
      onlyFreeTierModels: false,
    });
    assert.deepEqual(userOnly, configured);

    // Free only mode
    const freeOnly = resolveTierCandidateModels("apex", configured, {
      tierMode: "free",
      onlyFreeTierModels: false,
    });
    assert.ok(!freeOnly.includes("custom-provider/user-model-1"));
    assert.ok(freeOnly.length > 0);

    // Global onlyFreeTierModels toggle filters out paid configured models
    const globalFree = resolveTierCandidateModels(
      "apex",
      ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
      {
        tierMode: "both",
        onlyFreeTierModels: true,
      }
    );
    assert.ok(!globalFree.includes("openai/gpt-4o"));
    assert.ok(!globalFree.includes("anthropic/claude-3-5-sonnet"));
    for (const m of globalFree) {
      assert.equal(isFreeModelTarget(m), true);
    }

    // Both mode (union)
    const both = resolveTierCandidateModels("apex", configured, {
      tierMode: "both",
      onlyFreeTierModels: false,
    });
    assert.ok(both.includes("custom-provider/user-model-1"));
    assert.ok(both.length > configured.length);
  });
});
