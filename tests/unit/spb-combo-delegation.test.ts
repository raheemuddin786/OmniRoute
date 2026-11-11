import { test } from "node:test";
import assert from "node:assert/strict";

import { getDbInstance } from "../../src/lib/db/core.ts";
import { setTierConfig, getTierConfig } from "../../open-sse/services/tierResolver.ts";
import { getComboForModel } from "../../src/sse/services/model.ts";

test("SPB Combo Delegation: preserves registered combo identity, auto strategy, and nested targets", async () => {
  const db = getDbInstance();

  // Create a multi-combo structure with strategy='auto'
  const subCombo1 = {
    name: "test-sub-combo-1",
    strategy: "priority",
    models: [{ id: "m1", model: "provider-a/model-1" }],
  };
  const subCombo2 = {
    name: "test-sub-combo-2",
    strategy: "priority",
    models: [{ id: "m2", model: "provider-b/model-2" }],
  };
  const tierCombo = {
    name: "resilient/spb-tier-2-test",
    strategy: "auto",
    models: [
      { id: "ref1", kind: "combo-ref", comboName: "test-sub-combo-1", weight: 50 },
      { id: "ref2", kind: "combo-ref", comboName: "test-sub-combo-2", weight: 50 },
    ],
    config: {
      candidatePool: ["provider-a", "provider-b"],
    },
  };

  db.prepare(
    "INSERT OR REPLACE INTO combos (id, name, data, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run("test-sub-1", subCombo1.name, JSON.stringify(subCombo1));
  db.prepare(
    "INSERT OR REPLACE INTO combos (id, name, data, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run("test-sub-2", subCombo2.name, JSON.stringify(subCombo2));
  db.prepare(
    "INSERT OR REPLACE INTO combos (id, name, data, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
  ).run("test-tier-2", tierCombo.name, JSON.stringify(tierCombo));

  // Configure tierModels in tierConfig to use this registered combo
  setTierConfig({
    version: "1.0.0",
    defaults: { freeThreshold: 0, cheapThreshold: 1 },
    providerOverrides: [],
    modelOverrides: [],
    freeProviders: [],
    spbEnabled: true,
    tierModels: {
      apex: [],
      resilient: ["resilient/spb-tier-2-test"],
      local: [],
    },
  });

  const config = getTierConfig();
  assert.equal(config.spbEnabled, true);
  assert.deepEqual(config.tierModels?.resilient, ["resilient/spb-tier-2-test"]);

  // Verify getComboForModel retrieves the registered combo cleanly
  const loaded = await getComboForModel("resilient/spb-tier-2-test");
  assert.ok(loaded, "Combo must be found in SQLite");
  assert.equal(loaded.name, "resilient/spb-tier-2-test");
  assert.equal(loaded.strategy, "auto");
  assert.equal(loaded.models.length, 2);
  assert.equal(loaded.models[0].kind, "combo-ref");
  assert.equal(loaded.models[1].kind, "combo-ref");
});
