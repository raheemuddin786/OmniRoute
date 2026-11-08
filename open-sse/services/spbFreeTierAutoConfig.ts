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
import { getModelPricing } from "./providerCostData";
import { isCatalogFreeModel, isFreeModel } from "@/shared/utils/freeModels";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";

const lazyRequire = createRequire(import.meta.url);

/** Map of catalog free model budgets by lowercase slug (`provider/modelId`) */
const budgetsBySlug = new Map<string, (typeof FREE_MODEL_BUDGETS)[number]>();
for (const b of FREE_MODEL_BUDGETS) {
  budgetsBySlug.set(`${b.provider.toLowerCase()}/${b.modelId.toLowerCase()}`, b);
}

/**
 * Genuine zero-auth / keyless providers supported by OmniRoute without requiring credentials.
 */
const GENUINE_NOAUTH_PROVIDERS = new Set<string>(["pollinations", "ovhcloud", "aihorde"]);

/**
 * Curated slugs of verified free models from catalog that meet strict quality and zero-cost standards:
 * - Grants free access
 * - Not marked "avoid" in TOS
 * - Not "one-time-initial" (promotional trial credits) or "discontinued"
 * - Cost verified as zero in getModelPricing (or verified non-paid)
 */
const verifiedFreeCatalogSlugs = new Set<string>();
for (const b of FREE_MODEL_BUDGETS) {
  if (!grantsFreeAccess(b.freeType)) continue;
  if (b.tos === "avoid") continue;
  if (b.freeType === "one-time-initial" || b.freeType === "discontinued") continue;

  // For models with nested provider prefixes on reseller/aggregator providers, verify underlying pricing
  if (b.modelId.includes("/") && !GENUINE_NOAUTH_PROVIDERS.has(b.provider.toLowerCase())) {
    const [subProvider, ...rest] = b.modelId.split("/");
    const subModel = rest.join("/");
    const subPricing = getModelPricing(subProvider, subModel);
    if (!subPricing.isFree && (subPricing.inputCostPer1M > 0 || subPricing.outputCostPer1M > 0)) {
      continue;
    }
  }

  const pricing = getModelPricing(b.provider, b.modelId);
  if (
    !pricing.isFree &&
    !pricing.isEstimated &&
    (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)
  ) {
    continue;
  }

  verifiedFreeCatalogSlugs.add(`${b.provider.toLowerCase()}/${b.modelId.toLowerCase()}`);
}

/**
 * Checks whether a given model candidate string is a strictly verified free-tier model.
 * Inspects:
 * 1. Catalog budget entitlement regime (rejects promotional/trial one-time-initial, discontinued, and avoid TOS)
 * 2. Underlying provider pricing for reseller/aggregator paths
 * 3. Explicit model pricing (> 0 cost strictly rejected)
 * 4. Verified free catalog entries
 * 5. Genuine no-auth provider definitions
 * 6. ClassifyTier free economic assignment
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

  // 1. Budget entitlement check: promotional trial tokens, discontinued, or avoid TOS must NEVER pass as free
  for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
    const budget = budgetsBySlug.get(`${p}/${modelLower}`);
    if (budget) {
      if (budget.tos === "avoid") return false;
      if (budget.freeType === "one-time-initial" || budget.freeType === "discontinued")
        return false;
    }
  }

  // 2. Underlying provider check: for reseller/aggregator path-shaped models (e.g. api-airforce/anthropic/claude-3.7-sonnet)
  if (
    model.includes("/") &&
    !GENUINE_NOAUTH_PROVIDERS.has(provider) &&
    !GENUINE_NOAUTH_PROVIDERS.has(providerAlias) &&
    !GENUINE_NOAUTH_PROVIDERS.has(rawProvider)
  ) {
    const [subProvider, ...rest] = model.split("/");
    const subModel = rest.join("/");
    const subPricing = getModelPricing(subProvider, subModel);
    if (!subPricing.isFree && (subPricing.inputCostPer1M > 0 || subPricing.outputCostPer1M > 0)) {
      return false;
    }
  }

  // 3. Strict pricing check: if any provider pricing lookup gives cost > 0 or isFree === false, reject
  for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
    const pricing = getModelPricing(p, model);
    if (
      !pricing.isFree &&
      !pricing.isEstimated &&
      (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)
    ) {
      return false;
    }
    if (
      pricing.isEstimated &&
      !GENUINE_NOAUTH_PROVIDERS.has(p) &&
      !verifiedFreeCatalogSlugs.has(`${p}/${modelLower}`)
    ) {
      return false;
    }
  }

  // 4. Check verified free catalog slugs (which exclude avoid/one-time-initial/trial credits)
  if (provider && verifiedFreeCatalogSlugs.has(`${provider}/${modelLower}`)) return true;
  if (providerAlias && verifiedFreeCatalogSlugs.has(`${providerAlias}/${modelLower}`)) return true;
  if (rawProvider && verifiedFreeCatalogSlugs.has(`${rawProvider}/${modelLower}`)) return true;

  // 5. Check genuine no-auth providers
  for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
    if (GENUINE_NOAUTH_PROVIDERS.has(p)) {
      if (isCatalogFreeModel(p, model) || isFreeModel(p, { id: model })) {
        return true;
      }
    }
  }

  for (const p of [provider, providerAlias, rawProvider].filter(Boolean)) {
    if (p in NOAUTH_PROVIDERS) {
      return true;
    }
  }

  // 6. Check classifyTier
  try {
    const { classifyTier } = lazyRequire("./tierResolver") as {
      classifyTier: (provider: string, model: string) => { tier: string } | null;
    };
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
    const { getDbInstance } = lazyRequire("../../src/lib/db/core") as {
      getDbInstance: () => {
        prepare: (s: string) => { all: () => Array<{ provider: string }> };
      };
    };
    const db = getDbInstance();
    const rows = db
      .prepare("SELECT DISTINCT provider FROM provider_connections WHERE is_active = 1")
      .all();
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
  provider?: string
): "apex" | "resilient" | "local" {
  const m = modelId.toLowerCase();

  // Tier 3 (Local / Fast): Edge, lightweight, fast refactor, small parameter/context footprint
  if (
    /(^|[-_/])(mini|flash-lite|nano|micro|edge|local|ollama)([-_/]|$)/i.test(m) ||
    /[-_]([1-8]b)([-_/]|$)/i.test(m)
  ) {
    return "local";
  }

  // Capability resolution from model capabilities registry
  try {
    const caps = getResolvedModelCapabilities({ provider: provider || null, model: modelId });
    if (caps) {
      if (caps.contextWindow && caps.contextWindow <= 32768 && caps.supportsThinking !== true) {
        return "local";
      }
      if (caps.supportsThinking === true) {
        return "apex";
      }
    }
  } catch {
    // ignore
  }

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

  // Tier 2 (Resilient): Default balanced, tool calling, fast execution
  return "resilient";
}

/**
 * Discovers and returns all strictly verified free-tier models across active provider connections.
 * Applies stringent verification:
 * - Reject models with tos: "avoid"
 * - Reject models with freeType: "one-time-initial" (promotional trial credits) or "discontinued"
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

    // For reseller/aggregator path-shaped models, verify underlying provider pricing
    if (budget.modelId.includes("/") && !GENUINE_NOAUTH_PROVIDERS.has(providerLower)) {
      const [subProvider, ...rest] = budget.modelId.split("/");
      const subModel = rest.join("/");
      const subPricing = getModelPricing(subProvider, subModel);
      if (!subPricing.isFree && (subPricing.inputCostPer1M > 0 || subPricing.outputCostPer1M > 0)) {
        continue;
      }
    }

    // Verify model pricing is free
    const pricing = getModelPricing(budget.provider, budget.modelId);
    if (
      !pricing.isFree &&
      !pricing.isEstimated &&
      (pricing.inputCostPer1M > 0 || pricing.outputCostPer1M > 0)
    ) {
      continue;
    }
    if (pricing.isEstimated && !GENUINE_NOAUTH_PROVIDERS.has(providerLower)) {
      continue;
    }

    const fullModelSlug = `${budget.provider}/${budget.modelId}`;
    if (seen.has(fullModelSlug)) continue;
    seen.add(fullModelSlug);

    const tier = classifyFreeModelTier(budget.modelId, budget.provider);
    const mLower = budget.modelId.toLowerCase();

    let reasoningCap = mLower.includes("r1") || mLower.includes("reason") || mLower.includes("pro");
    let toolCallCap = !mLower.includes("base") && !mLower.includes("preview");
    let codingCap = mLower.includes("code") || mLower.includes("coder") || mLower.includes("plus");

    try {
      const caps = getResolvedModelCapabilities({
        provider: budget.provider,
        model: budget.modelId,
      });
      if (caps) {
        if (typeof caps.reasoning === "boolean") reasoningCap = caps.reasoning;
        if (typeof caps.toolCalling === "boolean") toolCallCap = caps.toolCalling;
      }
    } catch {
      // ignore
    }

    results.push({
      provider: budget.provider,
      model: budget.modelId,
      displayName: budget.displayName || budget.modelId,
      tier,
      capabilities: {
        reasoning: reasoningCap,
        toolCall: toolCallCap,
        coding: codingCap,
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
