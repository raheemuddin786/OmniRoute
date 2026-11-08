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
import { parseModel } from "./model";

const lazyRequire = createRequire(import.meta.url);

const freeCatalogSlugs = new Set<string>();
for (const b of FREE_MODEL_BUDGETS) {
  if (grantsFreeAccess(b.freeType)) {
    freeCatalogSlugs.add(`${b.provider.toLowerCase()}/${b.modelId.toLowerCase()}`);
  }
}

/**
 * Checks whether a given model candidate string is a verified free-tier model.
 * Inspects:
 * 1. FREE_MODEL_BUDGETS catalog
 * 2. isFreeForProvider & isFreeModel from shared utils
 * 3. classifyTier (free pricing tier)
 */
export function isFreeModelTarget(targetStr: string): boolean {
  if (!targetStr || typeof targetStr !== "string") return false;
  const trimmed = targetStr.trim();
  if (!trimmed) return false;

  const parsed = parseModel(trimmed);
  const provider = (parsed.provider || "").toLowerCase();
  const providerAlias = (parsed.providerAlias || "").toLowerCase();
  const model = parsed.model || trimmed;
  if (!provider && !providerAlias) return false;

  const modelLower = model.toLowerCase();
  const rawProvider = trimmed.includes("/") ? trimmed.split("/")[0].toLowerCase() : "";

  // Check freeCatalogSlugs against parsed canonical provider, alias, and raw prefix
  if (provider && freeCatalogSlugs.has(`${provider}/${modelLower}`)) return true;
  if (providerAlias && freeCatalogSlugs.has(`${providerAlias}/${modelLower}`)) return true;
  if (rawProvider && freeCatalogSlugs.has(`${rawProvider}/${modelLower}`)) return true;

  try {
    const { isFreeForProvider, isFreeModel } = lazyRequire("@/shared/utils/freeModels");
    if (provider && isFreeForProvider(provider, { id: model })) return true;
    if (providerAlias && isFreeForProvider(providerAlias, { id: model })) return true;
    if (rawProvider && isFreeForProvider(rawProvider, { id: model })) return true;
    if (provider && isFreeModel(provider, { id: model })) return true;
    if (providerAlias && isFreeModel(providerAlias, { id: model })) return true;
    if (rawProvider && isFreeModel(rawProvider, { id: model })) return true;
  } catch {
    // ignore
  }

  try {
    const { classifyTier } = lazyRequire("./tierResolver");
    if (provider) {
      const classification = classifyTier(provider, model);
      if (classification && classification.tier === "free") return true;
    }
    if (rawProvider && rawProvider !== provider) {
      const classification = classifyTier(rawProvider, model);
      if (classification && classification.tier === "free") return true;
    }
  } catch {
    // ignore
  }

  return false;
}

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

  // When onlyFreeTierModels is enabled, user-configured models MUST be strictly filtered
  // so paid models are NEVER included.
  const safeConfiguredModels = onlyFreeTierModels
    ? configuredModels.filter(isFreeModelTarget)
    : configuredModels;

  if (onlyFreeTierModels || tierMode === "free") {
    if (tierMode === "free") {
      return freeModels.length > 0 ? freeModels : safeConfiguredModels;
    }
    // onlyFreeTierModels active with tierMode "user" or "both"
    if (tierMode === "user") {
      return safeConfiguredModels.length > 0 ? safeConfiguredModels : freeModels;
    }
    // tierMode === "both" with onlyFreeTierModels
    const combinedFree = [...safeConfiguredModels];
    for (const fm of freeModels) {
      if (!combinedFree.includes(fm)) {
        combinedFree.push(fm);
      }
    }
    return combinedFree;
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
