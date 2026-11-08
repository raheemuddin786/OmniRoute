/**
 * Automated free-tier model discovery and capability classification for Smart Proxy Bridge & Combos.
 *
 * Sifts through active providers and free-tier catalog budgets (FREE_MODEL_BUDGETS) to automatically
 * populate and categorize free-tier candidates into:
 *   - Apex (Tier 1): Reasoning & coding capable free models
 *   - Resilient (Tier 2): Tool calling & high-throughput free models
 *   - Local (Tier 3): Ultra fast, low-latency, and local/edge free models
 */

import { FREE_MODEL_BUDGETS, grantsFreeAccess } from "../config/freeModelCatalog";
import { createRequire } from "node:module";
import type { TierSelectionMode } from "./tierTypes";

const lazyRequire = createRequire(import.meta.url);

export interface FreeTierDiscoveredModel {
  provider: string;
  model: string;
  displayName: string;
  tier: "apex" | "resilient" | "local";
  capabilities: {
    reasoning?: boolean;
    toolCall?: boolean;
    coding?: boolean;
  };
}

let cachedActiveProviders: { timestamp: number; providers: Set<string> } | null = null;
const CACHE_TTL_MS = 30_000;

export function getActiveConnectedProviders(): Set<string> {
  const now = Date.now();
  if (cachedActiveProviders && now - cachedActiveProviders.timestamp < CACHE_TTL_MS) {
    return cachedActiveProviders.providers;
  }

  const providers = new Set<string>();
  try {
    const getDbInstance = lazyRequire("../../src/lib/db/core").getDbInstance;
    const db = getDbInstance();
    const rows = db
      .prepare("SELECT DISTINCT provider FROM provider_connections WHERE is_active = 1")
      .all() as Array<{ provider: string }>;
    for (const row of rows) {
      if (row.provider) {
        providers.add(row.provider.toLowerCase().trim());
      }
    }
  } catch {
    // Fail-open: if DB lookup fails, allow discovery across all cataloged free providers
  }

  cachedActiveProviders = { timestamp: now, providers };
  return providers;
}

export function classifyFreeModelTier(
  modelId: string,
  _provider: string
): "apex" | "resilient" | "local" {
  const m = modelId.toLowerCase();

  // Tier 1 (Apex): Deep reasoning, high parameter, complex coding
  if (
    m.includes("r1") ||
    m.includes("reasoning") ||
    m.includes("coder") ||
    m.includes("opus") ||
    m.includes("max") ||
    m.includes("plus") ||
    m.includes("70b") ||
    m.includes("120b") ||
    m.includes("pro")
  ) {
    return "apex";
  }

  // Tier 3 (Local / Fast): Edge, lightweight, fast refactor, determinism
  if (
    /(^|[-_/])(mini|flash-lite|nano|micro|edge|local|ollama)([-_/]|$)/i.test(m) ||
    /[-_]([1-8]b)([-_/]|$)/i.test(m)
  ) {
    return "local";
  }

  // Tier 2 (Resilient): Default balanced, tool calling, fast execution
  return "resilient";
}

/**
 * Discovers and returns all available free-tier models across active provider connections.
 */
export function discoverAvailableFreeTierModels(): FreeTierDiscoveredModel[] {
  const activeProviders = getActiveConnectedProviders();
  const results: FreeTierDiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const budget of FREE_MODEL_BUDGETS) {
    if (!grantsFreeAccess(budget.freeType)) continue;

    const providerLower = budget.provider.toLowerCase();
    // If user has active connections, prioritize providers they have configured, or keyless/noauth
    if (activeProviders.size > 0 && !activeProviders.has(providerLower)) {
      if (budget.freeType !== "keyless" && budget.freeType !== "recurring-uncapped") {
        continue;
      }
    }

    const fullModelSlug = `${budget.provider}/${budget.modelId}`;
    if (seen.has(fullModelSlug)) continue;
    seen.add(fullModelSlug);

    const tier = classifyFreeModelTier(budget.modelId, budget.provider);
    const mLower = budget.modelId.toLowerCase();

    results.push({
      provider: budget.provider,
      model: budget.modelId,
      displayName: budget.displayName || budget.modelId,
      tier,
      capabilities: {
        reasoning: mLower.includes("r1") || mLower.includes("reason") || mLower.includes("pro"),
        toolCall: !mLower.includes("base") && !mLower.includes("preview"),
        coding: mLower.includes("code") || mLower.includes("coder") || mLower.includes("plus"),
      },
    });
  }

  return results;
}

/**
 * Resolves models for a tier based on user-configured models, tier mode, and global free toggle.
 */
export function resolveTierCandidateModels(
  tierKey: "apex" | "resilient" | "local",
  configuredModels: string[],
  options: {
    onlyFreeTierModels?: boolean;
    tierMode?: TierSelectionMode;
  } = {}
): string[] {
  const { onlyFreeTierModels = false, tierMode = "both" } = options;

  const freeModels = discoverAvailableFreeTierModels()
    .filter((m) => m.tier === tierKey)
    .map((m) => `${m.provider}/${m.model}`);

  if (onlyFreeTierModels || tierMode === "free") {
    return freeModels.length > 0 ? freeModels : configuredModels;
  }

  if (tierMode === "user") {
    return configuredModels.length > 0 ? configuredModels : freeModels;
  }

  // Mode "both": Union of user configured models + free auto-discovered models
  const combined = [...configuredModels];
  for (const fm of freeModels) {
    if (!combined.includes(fm)) {
      combined.push(fm);
    }
  }

  return combined;
}
