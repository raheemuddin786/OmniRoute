// src/lib/db/adapters/runtimeRequire.ts
/**
 * Load optional database drivers from the runtime rather than bundling them.
 *
 * The standalone server is emitted as CommonJS chunks and externalizes the
 * native database packages. Keep those requests as static `require()` calls so
 * webpack preserves the external boundary. Development and tests run as ESM,
 * where `require` is unavailable; the `createRequire(import.meta.url)` fallback
 * handles those callers.
 */
import { createRequire } from "node:module";

declare const require: NodeRequire | undefined;

function esmRuntimeRequire(specifier: string): unknown {
  return createRequire(import.meta.url)(specifier);
}

export function runtimeRequire(specifier: string): unknown {
  if (typeof require === "function") {
    try {
      switch (specifier) {
        case "better-sqlite3":
          return require("better-sqlite3");
        case "node:sqlite":
          return require("node:sqlite");
        case "bun:sqlite":
          return require("bun:sqlite");
        case "sql.js":
          return require("sql.js");
        case "sqlite-vec":
          return require("sqlite-vec");
      }
    } catch (err: unknown) {
      // In bundled ESM (e.g. esbuild --format=esm for MCP server), esbuild provides
      // a dummy `require` shim that throws "Dynamic require of ... is not supported".
      // When that happens, fall through to createRequire(import.meta.url) below.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Dynamic require of")) {
        throw err;
      }
    }
  }

  return esmRuntimeRequire(specifier);
}
