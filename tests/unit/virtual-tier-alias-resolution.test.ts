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

test("resolveVirtualTierModels expands database combo models configured in tierModels", async () => {
  const { getDbInstance } = await import("@/lib/db/core");
  const db = getDbInstance();

  // Insert a test nested combo into the combos table
  db.prepare(
    `
    INSERT OR REPLACE INTO combos (id, name, data, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
  `
  ).run(
    "test-nested-apex-combo-id",
    "test-nested-apex",
    JSON.stringify({
      name: "test-nested-apex",
      models: [{ model: "provider-a/nested-model-1" }, { model: "provider-b/nested-model-2" }],
    })
  );

  // Insert a parent combo that references the nested combo and a direct model
  db.prepare(
    `
    INSERT OR REPLACE INTO combos (id, name, data, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
  `
  ).run(
    "test-parent-apex-combo-id",
    "apex/spb-tier-1",
    JSON.stringify({
      name: "apex/spb-tier-1",
      models: [
        { kind: "combo-ref", comboName: "test-nested-apex" },
        { model: "provider-c/direct-model-3" },
      ],
    })
  );

  // Configure tierModels to use the combo name
  setTierConfig({
    tierModels: {
      apex: ["apex/spb-tier-1"],
      resilient: ["antigravity-tier2-resilient-execution"],
      local: ["qoder/local-coder"],
    },
  });

  const resolved = resolveVirtualTierModels("tier_1_apex");
  assert.deepStrictEqual(resolved, [
    "provider-a/nested-model-1",
    "provider-b/nested-model-2",
    "provider-c/direct-model-3",
  ]);

  // Clean up test combo rows
  db.prepare("DELETE FROM combos WHERE id IN (?, ?)").run(
    "test-nested-apex-combo-id",
    "test-parent-apex-combo-id"
  );
});
