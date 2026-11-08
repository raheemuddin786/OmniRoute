import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFreeModelTier,
  discoverAvailableFreeTierModels,
  resolveTierCandidateModels,
} from "../../open-sse/services/spbFreeTierAutoConfig.ts";

describe("SPB Free Tier Auto-Config", () => {
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

    // Global onlyFreeTierModels toggle
    const globalFree = resolveTierCandidateModels("apex", configured, {
      tierMode: "both",
      onlyFreeTierModels: true,
    });
    assert.ok(!globalFree.includes("custom-provider/user-model-1"));

    // Both mode (union)
    const both = resolveTierCandidateModels("apex", configured, {
      tierMode: "both",
      onlyFreeTierModels: false,
    });
    assert.ok(both.includes("custom-provider/user-model-1"));
    assert.ok(both.length > configured.length);
  });
});
