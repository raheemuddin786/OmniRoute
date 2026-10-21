import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const targetPaths = [
  join(homedir(), ".omniroute", "storage.sqlite"),
  "/Users/raheem/.omniroute/storage.sqlite",
];

const uniquePaths = Array.from(new Set(targetPaths));
for (const dbPath of uniquePaths) {
  console.log(`Connecting to database at ${dbPath}...`);
  const db = new Database(dbPath);

  const comboId = "c032a18e-49b8-4c6e-8ff5-6c7c427c3e10";
  const comboName = "apex-thinking";
  const now = new Date().toISOString();

  const comboData = {
    name: comboName,
    models: [
      {
        id: "apex-cw-sonnet-5",
        kind: "model",
        model: "claude-web/claude-sonnet-5",
        providerId: "claude-web",
        weight: 0,
      },
      {
        id: "apex-cw-sonnet-4-6",
        kind: "model",
        model: "claude-web/claude-sonnet-4-6",
        providerId: "claude-web",
        weight: 0,
      },
      {
        id: "apex-ag-opus-thinking",
        kind: "model",
        model: "antigravity/claude-opus-4-6-thinking",
        providerId: "antigravity",
        weight: 0,
      },
      {
        id: "apex-cohere-reasoning",
        kind: "model",
        model: "cohere/command-a-reasoning-08-2025",
        providerId: "cohere",
        weight: 0,
      },
      {
        id: "apex-or-nemotron-free",
        kind: "model",
        model: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
        providerId: "openrouter",
        weight: 0,
      },
    ],
    strategy: "priority",
    config: {
      targetTimeoutMs: 60000,
      maxRetries: 2,
      retryDelayMs: 2000,
      failoverBeforeRetry: true,
      trackMetrics: true,
      reasoningTokenBufferEnabled: true,
      zeroLatencyOptimizationsEnabled: true,
    },
    id: comboId,
    isHidden: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    version: 2,
  };

  const systemMessage =
    "You are Apex Thinking Engine, an autonomous reasoning and architectural planning agent. Focus strictly on deep analytical reasoning, structural problem solving, and concise deterministic synthesis. Tools are disabled for pure cognitive planning.";
  const toolFilterRegex = "^$"; // Strictly strip all tool schemas from being transmitted

  db.transaction(() => {
    // 1. Insert or Replace the combo
    db.prepare(
      `
    INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, system_message, tool_filter_regex, context_cache_protection)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      data = excluded.data,
      updated_at = excluded.updated_at,
      system_message = excluded.system_message,
      tool_filter_regex = excluded.tool_filter_regex,
      context_cache_protection = excluded.context_cache_protection;
  `
    ).run(comboId, comboName, JSON.stringify(comboData), now, now, systemMessage, toolFilterRegex);
    console.log(`✓ Combo "${comboName}" configured with priority fallback and tool filter.`);

    // 2. Assign default compression combo (session-dedup + lite) to apex-thinking
    db.prepare(
      `
    INSERT INTO compression_combo_assignments (id, compression_combo_id, routing_combo_id, created_at)
    VALUES (?, 'default-caveman', ?, ?)
    ON CONFLICT(routing_combo_id) DO UPDATE SET
      compression_combo_id = excluded.compression_combo_id;
  `
    ).run(`cca-${comboId}`, comboId, now);
    console.log(`✓ Assigned compression pipeline (session-dedup + lite) to "${comboName}".`);

    // 3. Update tier_config so Apex routes exclusively to apex-thinking
    const tierRow = db.prepare("SELECT value FROM tier_config WHERE key = 'tier_config'").get();
    if (tierRow) {
      const tierConfig = JSON.parse(tierRow.value);
      tierConfig.tierModels = tierConfig.tierModels || {};
      tierConfig.tierModels.apex = [comboName];
      db.prepare(
        "UPDATE tier_config SET value = ?, updated_at = datetime('now') WHERE key = 'tier_config'"
      ).run(JSON.stringify(tierConfig));
      console.log(`✓ Updated tier_config: apex tier dedicated exclusively to ["${comboName}"].`);
    }

    // 4. Update provider_connections for claude-web:
    // - rate_limit_protection = 1
    // - max_concurrent = 1 (strictly serializes requests to eliminate concurrent 429 collisions)
    // - rate_limit_overrides_json with 3.5s pacing gap (minTime: 3500) and rpm: 12
    // - provider_specific_data with minimalResponse: true
    const connections = db
      .prepare(
        "SELECT id, provider_specific_data FROM provider_connections WHERE provider = 'claude-web'"
      )
      .all();
    for (const conn of connections) {
      let specData = {};
      try {
        specData = JSON.parse(conn.provider_specific_data || "{}");
      } catch {}
      specData.minimalResponse = true;

      const rateLimitOverrides = {
        rpm: 12,
        minTime: 3500,
        maxConcurrent: 1,
        maxWaitMs: 120000,
      };

      db.prepare(
        `
      UPDATE provider_connections
      SET rate_limit_protection = 1,
          max_concurrent = 1,
          rate_limit_overrides_json = ?,
          provider_specific_data = ?,
          updated_at = datetime('now')
      WHERE id = ?;
    `
      ).run(JSON.stringify(rateLimitOverrides), JSON.stringify(specData), conn.id);
    }
    console.log(
      `✓ Updated ${connections.length} claude-web connection(s) with rate limiting, maxConcurrent=1, 3.5s pacing, and minimalResponse.`
    );

    // 5. Update resilienceSettings in key_value table
    const resRow = db.prepare("SELECT value FROM key_value WHERE key = 'resilienceSettings'").get();
    if (resRow) {
      const res = JSON.parse(resRow.value);
      res.connectionCooldown = res.connectionCooldown || {};
      res.connectionCooldown.apikey = res.connectionCooldown.apikey || {};
      res.connectionCooldown.apikey.baseCooldownMs = 30000; // 30s base cooldown
      res.connectionCooldown.apikey.maxBackoffSteps = 4;
      res.comboCooldownWait = {
        enabled: true,
        maxWaitMs: 15000,
        maxAttempts: 3,
        budgetMs: 45000,
      };
      res.providerCooldown = {
        enabled: true,
        minRetryCooldownMs: 15000,
        maxRetryCooldownMs: 300000,
      };
      db.prepare("UPDATE key_value SET value = ? WHERE key = 'resilienceSettings'").run(
        JSON.stringify(res)
      );
      console.log(
        "✓ Updated resilienceSettings: apikey baseCooldownMs=30s, comboCooldownWait=15s/3attempts."
      );
    }
  })();
  db.close();
  console.log(`Database at ${dbPath} updated successfully.`);
}
console.log("All configuration updates applied across all targets successfully!");
