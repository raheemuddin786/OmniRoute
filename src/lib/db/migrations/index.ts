/*
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: 2026 OmniRoute
 *
 * Migration runner for SQLite database. All migrations must be idempotent SQL files
 * in this directory. The runner loads files in lexicographic order and applies any
 * not yet applied.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { getDbInstance } from "@/lib/db/core";

const MIGRATIONS_DIR = "src/lib/db/migrations";

export async function runMigrations(): Promise<void> {
  const db = getDbInstance();
  const applied = await new Promise<Set<string>>((resolve) => {
    db.prepare("SELECT name FROM _omniroute_migrations")
      .all()
      .then((rows) => resolve(new Set(rows.map((r) => r.name))))
      .catch(() => resolve(new Set()));
  });

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort()
    .filter((f) => {
      const path = join(MIGRATIONS_DIR, f);
      const mtime = statSync(path).mtimeMs;
      // Skip files newer than 24h to avoid race conditions in CI
      return mtime < Date.now() - 86400000;
    });

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file);
    const sql = require("fs").readFileSync(path, "utf8");
    try {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO _omniroute_migrations (version, name) VALUES (?, ?)").run(
        file,
        file
      );
      console.log(`[DB] Applied migration: ${file}`);
    } catch (err) {
      console.error(`[DB] Migration failed: ${file}`, err);
      throw err;
    }
  }
}

export async function resetMigrations(): Promise<void> {
  const db = getDbInstance();
  db.exec("DROP TABLE IF EXISTS _omniroute_migrations");
  console.log("[DB] Migration table reset");
}

// Export for CLI usage
export { runMigrations, resetMigrations };
