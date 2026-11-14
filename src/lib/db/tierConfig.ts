import { getDbInstance } from "./core";
import type { TierConfig } from "../../../open-sse/services/tierTypes";
import { validateTierConfig, DEFAULT_TIER_CONFIG } from "../../../open-sse/services/tierConfig";
import { defaultLogger as log } from "@omniroute/open-sse/utils/logger";

const TABLE = "tier_config";
const CORRUPTED_VALUE_PREVIEW_LEN = 200;

export function initTierConfigTable(): void {
  const db = getDbInstance();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export type { TierConfig } from "../../../open-sse/services/tierTypes";

export function saveTierConfig(config: TierConfig, profileKey: string = "tier_config"): void {
  const db = getDbInstance();
  const serialized = JSON.stringify(config);
  const key = profileKey.startsWith("tier_config") ? profileKey : `tier_config:${profileKey}`;
  db.prepare(
    `INSERT OR REPLACE INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, datetime('now'))`
  ).run(key, serialized);
}

/**
 * Truncate an unknown value (string) for safe inclusion in a log payload.
 * Returns the string verbatim when shorter than the cap, otherwise a
 * 200-char preview with an ellipsis. `String(value)` is used as a final
 * fallback so a non-string never throws here.
 */
function previewCorruptedValue(value: unknown): string {
  if (typeof value !== "string") return String(value);
  if (value.length <= CORRUPTED_VALUE_PREVIEW_LEN) return value;
  return `${value.slice(0, CORRUPTED_VALUE_PREVIEW_LEN)}…`;
}

/**
 * Load the persisted tier config from SQLite. Returns `null` when no row exists
 * OR when the stored value is unreadable (invalid JSON, fails Zod validation).
 */
export function loadTierConfigFromDb(profileKey: string = "tier_config"): TierConfig | null {
  const db = getDbInstance();
  const key = profileKey.startsWith("tier_config") ? profileKey : `tier_config:${profileKey}`;
  const row = db.prepare(`SELECT value FROM ${TABLE} WHERE key = ?`).get(key) as
    { value: string } | undefined;
  if (!row) return null;

  const raw = row.value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), value: previewCorruptedValue(raw) },
      `tier_config JSON.parse failed for key '${key}'; falling back to DEFAULT_TIER_CONFIG`
    );
    return null;
  }

  try {
    return validateTierConfig(parsed);
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        value: previewCorruptedValue(raw),
      },
      `tier_config Zod validation failed for key '${key}'; falling back to DEFAULT_TIER_CONFIG`
    );
    return null;
  }
}

export function loadTierConfig(profileKey: string = "tier_config"): TierConfig {
  return loadTierConfigFromDb(profileKey) || DEFAULT_TIER_CONFIG;
}

/**
 * List all configured SPB profile names stored in tier_config table.
 * Returns default "default" profile plus any named profiles (e.g. "spb1", "spb2").
 */
export function listTierConfigProfiles(): string[] {
  const db = getDbInstance();
  const rows = db.prepare(`SELECT key FROM ${TABLE}`).all() as Array<{ key: string }>;
  const profiles = new Set<string>(["default"]);
  for (const r of rows) {
    if (r.key === "tier_config") {
      profiles.add("default");
    } else if (r.key.startsWith("tier_config:")) {
      const name = r.key.slice("tier_config:".length);
      if (name) profiles.add(name);
    }
  }
  return Array.from(profiles);
}

/**
 * Delete a named SPB profile from tier_config table.
 * Returns true if deleted, false if default or not found.
 */
export function deleteTierConfigProfile(profileName: string): boolean {
  if (!profileName || profileName === "default" || profileName === "spb") {
    return false; // Cannot delete the default profile
  }
  const db = getDbInstance();
  const key = profileName.startsWith("tier_config:") ? profileName : `tier_config:${profileName}`;
  const res = db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(key);
  return res.changes > 0;
}
