import test from "node:test";
import assert from "node:assert";
import { resolveModelAliasWithSeedFallback } from "@/lib/modelAliasResolver";
import { resolveVirtualTierModels, setTierConfig } from "@omniroute/open-sse/services/tierResolver";

test("virtual tiers and resilient/spb model prefixes pass through alias resolver unchanged", async () => {
  const models = [
    "resilient/spb-tier-2",
    "spb-tier-2",
    "tier_2_resilient",
    "resilient/apex",
    "spb-apex",
  ];

  for (const model of models) {
    const resolved = await resolveModelAliasWithSeedFallback(model);
    assert.strictEqual(
      resolved,
      model,
      `Expected virtual model "${model}" to pass through unchanged, but got "${resolved}"`
    );
  }
});

test("resolveVirtualTierModels resolves virtual tier identifiers and filters self-referential virtual models", async () => {
  // Configure tier models containing both real models and virtual identifiers
  setTierConfig({
    tierModels: {
      apex: ["claude-opus-5", "apex/claude-sonnet-5.5"],
      resilient: ["resilient/spb-tier-2", "antigravity-tier2-resilient-execution", "spb-tier-2"],
      local: ["qoder/local-coder", "local/spb-tier-3"],
    },
  });

  const resilientCandidates = resolveVirtualTierModels("resilient/spb-tier-2");
  // Must return only concrete models, filtering out self-referential virtual identifiers
  assert.deepStrictEqual(resilientCandidates, ["antigravity-tier2-resilient-execution"]);

  const apexCandidates = resolveVirtualTierModels("tier_1_apex");
  assert.deepStrictEqual(apexCandidates, ["claude-opus-5"]);

  const localCandidates = resolveVirtualTierModels("tier-3");
  assert.deepStrictEqual(localCandidates, ["qoder/local-coder"]);
});
