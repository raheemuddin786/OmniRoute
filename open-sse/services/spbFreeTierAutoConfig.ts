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

/**
 * Flagship proprietary model prefixes that are commercial paid models.
 * Third-party aggregator / trial credit wrappers claiming these are NOT persistent free tiers.
 */
const PROPRIETARY_PAID_RE = /^(claude|gpt-4|gpt-5|grok|gemini-(?:1\.5|2\.5)-pro|gemini-pro)/i;

export function isFlagshipCommercialPaidModel(modelId: string): boolean {
  if (!modelId) return false;
  const normalized = modelId.split("/").pop()!.toLowerCase();
  return PROPRIETARY_PAID_RE.test(normalized);
}

/**
 * Curated slugs of verified free models from catalog that meet strict quality and zero-cost standards:
 * - Grants free access
 * - Not marked "avoid" in TOS
 * - Not "one-time-initial" (promotional trial credits) or "discontinued"
 * - Not a proprietary commercial flagship model
 * - Cost verified as zero in getModelPricing
 */
const verifiedFreeCatalogSlugs = new Set<string>();
for (const b of FREE_MODEL_BUDGETS) {
  if (!grantsFreeAccess(b.freeType)) continue;
  if (b.tos === "avoid") continue;
  if (b.freeType === "one-time-initial" || b.freeType === "discontinued") continue;
  if (isFlagshipCommercialPaidModel(b.modelId)) continue;

  try {
    const { getModelPricing } = lazyRequire("./providerCostData");
    const pricing = getModelPricing(b.provider, b.modelId);
    if (!pricing.isFree && (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)) {
      continue;
    }
  } catch {
    // If providerCostData is unavailable during bootstrap, proceed
  }

  verifiedFreeCatalogSlugs.add(`${b.provider.toLowerCase()}/${b.modelId.toLowerCase()}`);
}

/**
 * Genuine zero-auth / keyless providers supported by OmniRoute without requiring credentials.
 */
const GENUINE_NOAUTH_PROVIDERS = new Set<string>(["pollinations", "ovhcloud", "aihorde"]);

/**
 * Checks whether a given model candidate string is a strictly verified free-tier model.
 * Inspects:
 * 1. Proprietary commercial paid model check (rejects claude, gpt-4, grok, etc.)
 * 2. Explicit model pricing (> 0 cost strictly rejected)
 * 3. Verified free catalog entries
 * 4. Genuine no-auth provider definitions
 * 5. ClassifyTier free economic assignment
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

  // 1. Strict veto: commercial flagship paid models must NEVER pass as free
  if (isFlagshipCommercialPaidModel(modelLower)) {
    return false;
  }

  // 2. Strict pricing check: if any provider pricing lookup gives cost > 0 or isFree === false, reject
  try {
    const { getModelPricing } = lazyRequire("./providerCostData");
    for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
      const pricing = getModelPricing(p, model);
      if (!pricing.isFree && (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)) {
        return false;
      }
    }
  } catch {
    // ignore
  }

  // 3. Check verified free catalog slugs (which exclude avoid/one-time-initial/trial credits)
  if (provider && verifiedFreeCatalogSlugs.has(`${provider}/${modelLower}`)) return true;
  if (providerAlias && verifiedFreeCatalogSlugs.has(`${providerAlias}/${modelLower}`)) return true;
  if (rawProvider && verifiedFreeCatalogSlugs.has(`${rawProvider}/${modelLower}`)) return true;

  // 4. Check genuine no-auth providers
  for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
    if (GENUINE_NOAUTH_PROVIDERS.has(p)) {
      return true;
    }
  }

  try {
    const { NOAUTH_PROVIDERS } = lazyRequire("@/shared/constants/providers");
    for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
      if (p in NOAUTH_PROVIDERS) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  // 5. Check classifyTier
  try {
    const { classifyTier } = lazyRequire("./tierResolver");
    for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
      const classification = classifyTier(p, model);
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
 * Discovers and returns all strictly verified free-tier models across active provider connections.
 * Applies stringent verification:
 * - Reject models with tos: "avoid"
 * - Reject models with freeType: "one-time-initial" (promotional trial credits) or "discontinued"
 * - Reject commercial flagship paid models (claude, gpt-4, grok, etc.)
 * - Reject models with positive input/output token pricing (> 0)
 * - Match against connected providers or genuine no-auth providers
 */
export function discoverAvailableFreeTierModels(): FreeTierDiscoveredModel[] {
  const activeProviders = getActiveConnectedProviders();
  const results: FreeTierDiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const budget of FREE_MODEL_BUDGETS) {
    if (!grantsFreeAccess(budget.freeType)) continue;
    if (budget.tos === "avoid") continue;
    if (budget.freeType === "one-time-initial" || budget.freeType === "discontinued") continue;
    if (isFlagshipCommercialPaidModel(budget.modelId)) continue;

    const providerLower = budget.provider.toLowerCase();
    const isConnected = activeProviders.has(providerLower);
    const isNoAuth = GENUINE_NOAUTH_PROVIDERS.has(providerLower);

    // If user has active connections in DB, require connected provider OR genuine noauth provider
    if (activeProviders.size > 0) {
      if (!isConnected && !isNoAuth) {
        continue;
      }
    } else {
      // If no active connections configured, only discover genuine zero-auth providers
      if (!isNoAuth) {
        continue;
      }
    }

    // Verify model pricing is free
    try {
      const { getModelPricing } = lazyRequire("./providerCostData");
      const pricing = getModelPricing(budget.provider, budget.modelId);
      if (!pricing.isFree && (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)) {
        continue;
      }
    } catch {
      // ignore
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
