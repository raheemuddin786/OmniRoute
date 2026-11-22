/**
 * Tier configuration schema with Zod validation and sensible defaults.
 *
 * `freeProviders` is the union of two sources:
 *   1. Legacy explicit list (`LEGACY_FREE_PROVIDERS`) — keeps historical behavior
 *      for providers that aren't noAuth (e.g., groq, cerebras) so the old test
 *      suite and existing DB overrides keep working.
 *   2. Auto-derived from `NOAUTH_PROVIDERS` where `noAuth === true` AND
 *      `serviceKinds` is empty or includes "llm" (excludes free audio/video
 *      gateways like veo-free that would never feed the chat tier resolver).
 *      See `deriveNoAuthFreeProviders()`.
 *
 * The two are merged into `DEFAULT_TIER_CONFIG.freeProviders` at module load.
 */

import { z } from "zod";
import { type TierConfig, DEFAULT_SPB_TIER_MODELS, DEFAULT_SPB_RUNTIME_CONFIG } from "./tierTypes";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";

export const providerTierOverrideSchema = z.object({
  provider: z.string().min(1),
  tier: z.enum(["free", "cheap", "premium"]),
});

export const modelTierOverrideSchema = z.object({
  provider: z.string().min(1),
  modelPattern: z.string().min(1),
  tier: z.enum(["free", "cheap", "premium"]),
});

export const spbRuntimeConfigSchema = z
  .object({
    stagnationThreshold: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_SPB_RUNTIME_CONFIG.stagnationThreshold),
    multiFileThreshold: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_SPB_RUNTIME_CONFIG.multiFileThreshold),
    duplicateReadThreshold: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_SPB_RUNTIME_CONFIG.duplicateReadThreshold),
    diffTimeoutMs: z.number().int().min(500).default(DEFAULT_SPB_RUNTIME_CONFIG.diffTimeoutMs),
    minResponseLength: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_SPB_RUNTIME_CONFIG.minResponseLength),
    retryStatusCodes: z
      .array(z.number().int())
      .default(DEFAULT_SPB_RUNTIME_CONFIG.retryStatusCodes),
    strictCompletion: z.boolean().default(DEFAULT_SPB_RUNTIME_CONFIG.strictCompletion),
    intentLedgerMode: z
      .enum(["off", "heuristic", "apex_guided", "apex_shadow"])
      .default(DEFAULT_SPB_RUNTIME_CONFIG.intentLedgerMode),
    maxLedgerItems: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(DEFAULT_SPB_RUNTIME_CONFIG.maxLedgerItems),
    maxReprompts: z.number().int().min(0).max(10).default(DEFAULT_SPB_RUNTIME_CONFIG.maxReprompts),
    requireGitDiffEvidence: z.boolean().default(DEFAULT_SPB_RUNTIME_CONFIG.requireGitDiffEvidence),
    requireTestPassBeforeDone: z
      .boolean()
      .default(DEFAULT_SPB_RUNTIME_CONFIG.requireTestPassBeforeDone),
    tokenBounds: z
      .object({
        apex: z
          .object({
            high: z.number().int().min(1).default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex.high),
            medium: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex.medium),
            low: z.number().int().min(1).default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex.low),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex),
        resilient: z
          .object({
            high: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient.high),
            medium: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient.medium),
            low: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient.low),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient),
        local: z
          .object({
            high: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local.high),
            medium: z
              .number()
              .int()
              .min(1)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local.medium),
            low: z.number().int().min(1).default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local.low),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local),
      })
      .default(DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds),
    tierProfiles: z
      .object({
        apex: z
          .object({
            temperature: z
              .number()
              .min(0)
              .max(2)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex.temperature),
            reasoningEffort: z
              .enum(["low", "medium", "high"])
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex.reasoningEffort),
            systemPrompt: z.string().max(50000).optional(),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex),
        resilient: z
          .object({
            temperature: z
              .number()
              .min(0)
              .max(2)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient.temperature),
            reasoningEffort: z
              .enum(["low", "medium", "high"])
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient.reasoningEffort),
            systemPrompt: z.string().max(50000).optional(),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient),
        local: z
          .object({
            temperature: z
              .number()
              .min(0)
              .max(2)
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local.temperature),
            reasoningEffort: z
              .enum(["low", "medium", "high"])
              .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local.reasoningEffort),
            systemPrompt: z.string().max(50000).optional(),
          })
          .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local),
      })
      .default(DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles),
  })
  .default(DEFAULT_SPB_RUNTIME_CONFIG);

export const tierConfigSchema = z.object({
  version: z.string().default("1.0.0"),
  defaults: z
    .object({
      freeThreshold: z.number().min(0).default(0),
      cheapThreshold: z.number().min(0).default(1.0),
    })
    .default({ freeThreshold: 0, cheapThreshold: 1.0 }),
  providerOverrides: z.array(providerTierOverrideSchema).default([]),
  modelOverrides: z.array(modelTierOverrideSchema).default([]),
  freeProviders: z.array(z.string()).default([]),
  spbEnabled: z.boolean().default(false),
  onlyFreeTierModels: z.boolean().default(false),
  tierModes: z
    .object({
      apex: z.enum(["free", "user", "both"]).default("both"),
      resilient: z.enum(["free", "user", "both"]).default("both"),
      local: z.enum(["free", "user", "both"]).default("both"),
    })
    .default({ apex: "both", resilient: "both", local: "both" }),
  tierWeights: z
    .object({
      apex: z.number().min(0).max(1).default(0.3),
      resilient: z.number().min(0).max(1).default(0.5),
      local: z.number().min(0).max(1).default(0.2),
    })
    .default({ apex: 0.3, resilient: 0.5, local: 0.2 }),
  tierModels: z
    .object({
      apex: z.array(z.string().min(1)).default([]),
      resilient: z.array(z.string().min(1)).default([]),
      local: z.array(z.string().min(1)).default([]),
    })
    .default({ apex: [], resilient: [], local: [] }),
  tierProviders: z
    .object({
      apex: z.array(z.string().min(1)).default([]),
      resilient: z.array(z.string().min(1)).default([]),
      local: z.array(z.string().min(1)).default([]),
    })
    .default({ apex: [], resilient: [], local: [] })
    .optional(),
  cacheThreshold: z.number().min(0).default(5000),
  fallbackTimeout: z.number().min(0).default(5000),
  spbConfig: spbRuntimeConfigSchema.optional(),
});

/**
 * Legacy explicit free providers — kept for back-compat with existing DB rows
 * and test fixtures. New free providers should be added by registering them
 * in `NOAUTH_PROVIDERS` with `noAuth: true` instead of editing this list.
 */
export const LEGACY_FREE_PROVIDERS: readonly string[] = [
  "kiro",
  "qoder",
  "pollinations",
  "longcat",
  "cloudflare-ai",
  "nvidia-nim",
  "groq",
];

/**
 * Derive free provider IDs from `NOAUTH_PROVIDERS`. Only chat-tier noAuth
 * providers count (serviceKinds === undefined || includes "llm"), so the
 * free video / audio / image noAuth entries (e.g. veo-free, muse-spark) don't
 * accidentally mark themselves as chat-free.
 *
 * Wrapped in try/catch to tolerate the import failing in non-Node runtimes
 * (vitest worker setup, MCP server entry) — the legacy list still applies.
 */
export function deriveNoAuthFreeProviders(): string[] {
  try {
    const ids: string[] = [];
    for (const def of Object.values(NOAUTH_PROVIDERS)) {
      if (!def || typeof def !== "object") continue;
      if (def.noAuth !== true) continue;
      const kinds = (def as { serviceKinds?: unknown }).serviceKinds;
      const isLlm =
        !Array.isArray(kinds) || kinds.length === 0 || (kinds as unknown[]).includes("llm");
      if (!isLlm) continue;
      if (typeof def.id === "string" && def.id.length > 0) {
        ids.push(def.id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}

const NOAUTH_FREE_PROVIDERS = deriveNoAuthFreeProviders();

export const DEFAULT_TIER_CONFIG: TierConfig = {
  version: "1.0.0",
  defaults: {
    freeThreshold: 0,
    cheapThreshold: 1.0,
  },
  providerOverrides: [],
  modelOverrides: [],
  freeProviders: [...new Set([...LEGACY_FREE_PROVIDERS, ...NOAUTH_FREE_PROVIDERS])],
  spbEnabled: false,
  tierWeights: {
    apex: 0.3,
    resilient: 0.5,
    local: 0.2,
  },
  tierModels: DEFAULT_SPB_TIER_MODELS,
  cacheThreshold: 5000,
  fallbackTimeout: 5000,
  spbConfig: DEFAULT_SPB_RUNTIME_CONFIG,
};

export function validateTierConfig(raw: unknown): TierConfig {
  return tierConfigSchema.parse(raw);
}

export function mergeTierConfig(userConfig?: Partial<TierConfig>): TierConfig {
  if (!userConfig) return DEFAULT_TIER_CONFIG;
  return {
    ...DEFAULT_TIER_CONFIG,
    ...userConfig,
    defaults: {
      ...DEFAULT_TIER_CONFIG.defaults,
      ...userConfig.defaults,
    },
    providerOverrides: [
      ...DEFAULT_TIER_CONFIG.providerOverrides,
      ...(userConfig.providerOverrides || []),
    ],
    modelOverrides: [...DEFAULT_TIER_CONFIG.modelOverrides, ...(userConfig.modelOverrides || [])],
    freeProviders: [
      ...new Set([...DEFAULT_TIER_CONFIG.freeProviders, ...(userConfig.freeProviders || [])]),
    ],
    tierWeights: userConfig.tierWeights
      ? { ...DEFAULT_TIER_CONFIG.tierWeights!, ...userConfig.tierWeights }
      : DEFAULT_TIER_CONFIG.tierWeights,
    tierModels: userConfig.tierModels
      ? {
          apex: Array.isArray(userConfig.tierModels.apex) ? userConfig.tierModels.apex : [],
          resilient: Array.isArray(userConfig.tierModels.resilient)
            ? userConfig.tierModels.resilient
            : [],
          local: Array.isArray(userConfig.tierModels.local) ? userConfig.tierModels.local : [],
        }
      : {
          apex: [],
          resilient: [],
          local: [],
        },
    cacheThreshold: userConfig.cacheThreshold ?? DEFAULT_TIER_CONFIG.cacheThreshold,
    fallbackTimeout: userConfig.fallbackTimeout ?? DEFAULT_TIER_CONFIG.fallbackTimeout,
    spbConfig: userConfig.spbConfig
      ? {
          ...DEFAULT_SPB_RUNTIME_CONFIG,
          ...userConfig.spbConfig,
          tokenBounds: {
            apex: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex,
              ...(userConfig.spbConfig.tokenBounds?.apex || {}),
            },
            resilient: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient,
              ...(userConfig.spbConfig.tokenBounds?.resilient || {}),
            },
            local: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local,
              ...(userConfig.spbConfig.tokenBounds?.local || {}),
            },
          },
          tierProfiles: {
            apex: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex,
              ...(userConfig.spbConfig.tierProfiles?.apex || {}),
            },
            resilient: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient,
              ...(userConfig.spbConfig.tierProfiles?.resilient || {}),
            },
            local: {
              ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local,
              ...(userConfig.spbConfig.tierProfiles?.local || {}),
            },
          },
        }
      : DEFAULT_TIER_CONFIG.spbConfig,
  };
}
