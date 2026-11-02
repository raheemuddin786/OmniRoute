/**
 * Model Health Cache
 * Tracks per-model health metrics to detect zombie models (continuously failing)
 */

import { getDbInstance } from "../../../src/lib/db/core.ts";

interface ModelHealthEntry {
  modelStr: string;
  provider: string;
  lastSuccess: number;
  lastFailure: number;
  consecutiveFailures: number;
  continuousFailures: number; // seconds of continuous failures
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

const healthCache = new Map<string, ModelHealthEntry>();
const _CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(modelStr: string, provider: string): string {
  return `${provider}:${modelStr}`;
}

function getHealthEntry(modelStr: string, provider: string): ModelHealthEntry {
  const key = getCacheKey(modelStr, provider);
  let entry = healthCache.get(key);
  if (!entry) {
    entry = {
      modelStr,
      provider,
      lastSuccess: 0,
      lastFailure: 0,
      consecutiveFailures: 0,
      continuousFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
    };
    healthCache.set(key, entry);
  }
  return entry;
}

/**
 * Record a successful model response
 */
export function recordModelHealthSuccess(modelStr: string, provider: string): void {
  const entry = getHealthEntry(modelStr, provider);
  const now = Date.now();
  entry.lastSuccess = now;
  entry.consecutiveFailures = 0;
  entry.continuousFailures = 0;
  entry.totalRequests++;
  entry.successfulRequests++;
}

/**
 * Record a failed model response
 */
export function recordModelHealthFailure(
  modelStr: string,
  provider: string,
  _isTransient: boolean = false
): void {
  const entry = getHealthEntry(modelStr, provider);
  const now = Date.now();
  entry.lastFailure = now;
  entry.consecutiveFailures++;
  if (entry.lastSuccess === 0 || now - entry.lastSuccess > 60000) {
    // If no success in the last minute, increment continuous failure counter
    entry.continuousFailures = Math.min(entry.continuousFailures + 60, 24 * 60 * 60); // Cap at 24 hours
  }
  entry.totalRequests++;
  entry.failedRequests++;
}

/**
 * Get model health cache entry
 */
export async function getModelHealthCache(
  modelStr: string,
  provider: string
): Promise<ModelHealthEntry> {
  // Check in-memory cache first
  const entry = getHealthEntry(modelStr, provider);

  // Also try to load from database for persistence across restarts
  try {
    const db = getDbInstance();
    const row = db
      .prepare(`SELECT * FROM model_health_cache WHERE provider = ? AND model_str = ?`)
      .get(provider, modelStr) as ModelHealthEntry | undefined;

    if (row) {
      // Merge with in-memory (in-memory takes precedence for recent data)
      entry.continuousFailures = Math.max(entry.continuousFailures, row.continuousFailures || 0);
      entry.consecutiveFailures = Math.max(entry.consecutiveFailures, row.consecutiveFailures || 0);
      entry.totalRequests = Math.max(entry.totalRequests, row.totalRequests || 0);
      entry.successfulRequests = Math.max(entry.successfulRequests, row.successfulRequests || 0);
      entry.failedRequests = Math.max(entry.failedRequests, row.failedRequests || 0);
    }
  } catch {
    // Table may not exist yet, ignore
  }

  return entry;
}

/**
 * Record model health result (success or failure)
 */
export function recordModelHealthResult(
  modelStr: string,
  provider: string,
  success: boolean,
  isTransient: boolean = false
): void {
  if (success) {
    recordModelHealthSuccess(modelStr, provider);
  } else {
    recordModelHealthFailure(modelStr, provider, isTransient);
  }

  // Persist to database periodically
  if (Math.random() < 0.01) {
    // 1% chance to persist to reduce DB writes
    persistModelHealthCache(modelStr, provider);
  }
}

/**
 * Persist model health cache to database
 */
async function persistModelHealthCache(modelStr: string, provider: string): Promise<void> {
  try {
    const db = getDbInstance();
    const entry = getHealthEntry(modelStr, provider);

    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS model_health_cache (
        provider TEXT NOT NULL,
        model_str TEXT NOT NULL,
        last_success INTEGER,
        last_failure INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        continuous_failures INTEGER DEFAULT 0,
        total_requests INTEGER DEFAULT 0,
        successful_requests INTEGER DEFAULT 0,
        failed_requests INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (provider, model_str)
      )
    `
    ).run();

    db.prepare(
      `
      INSERT OR REPLACE INTO model_health_cache
      (provider, model_str, last_success, last_failure, consecutive_failures, continuous_failures,
       total_requests, successful_requests, failed_requests, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    `
    ).run(
      provider,
      modelStr,
      entry.lastSuccess,
      entry.lastFailure,
      entry.consecutiveFailures,
      entry.continuousFailures,
      entry.totalRequests,
      entry.successfulRequests,
      entry.failedRequests
    );
  } catch (error) {
    // Silently fail - health cache is best effort
    console.debug("[ModelHealthCache] Persist failed:", error);
  }
}

/**
 * Clear model health cache (for tests)
 */
export function clearModelHealthCache(): void {
  healthCache.clear();
}
