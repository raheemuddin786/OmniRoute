import test from "node:test";
import assert from "node:assert";
import { resolveModelAliasWithSeedFallback } from "@/lib/modelAliasResolver";

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
