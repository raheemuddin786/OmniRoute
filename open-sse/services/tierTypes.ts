export const PROVIDER_TIER = {
  FREE: "free",
  CHEAP: "cheap",
  PREMIUM: "premium",
} as const;

export type ProviderTier = (typeof PROVIDER_TIER)[keyof typeof PROVIDER_TIER];

export interface TierAssignment {
  provider: string;
  model: string;
  tier: ProviderTier;
  reason: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  hasFreeTier: boolean;
  freeQuotaLimit?: number;
}

export interface TierModelsConfig {
  apex: string[];
  resilient: string[];
  local: string[];
}

export interface TierProvidersConfig {
  apex: string[];
  resilient: string[];
  local: string[];
}

export type TierSelectionMode = "free" | "user" | "both";

export interface TierModesConfig {
  apex: TierSelectionMode;
  resilient: TierSelectionMode;
  local: TierSelectionMode;
}

export const DEFAULT_SPB_TIER_MODELS: TierModelsConfig = {
  apex: [],
  resilient: [],
  local: [],
};

export const DEFAULT_SPB_TIER_MODES: TierModesConfig = {
  apex: "both",
  resilient: "both",
  local: "both",
};

export interface SpbTokenBoundTier {
  high: number;
  medium: number;
  low: number;
}

export interface SpbTierProfile {
  temperature: number;
  reasoningEffort: "low" | "medium" | "high";
  systemPrompt?: string;
}

export interface SpbRuntimeConfig {
  stagnationThreshold?: number;
  stagnationIntervalMs?: number;
  enableSelfCorrectionPrompt?: boolean;
  multiFileThreshold?: number;
  duplicateReadThreshold?: number;
  diffTimeoutMs?: number;
  minResponseLength?: number;
  retryStatusCodes?: number[];
  strictCompletion?: boolean;
  intentLedgerMode?: "off" | "heuristic" | "apex_guided" | "apex_shadow";
  maxLedgerItems?: number;
  maxReprompts?: number;
  requireGitDiffEvidence?: boolean;
  requireTestPassBeforeDone?: boolean;
  tokenBounds?: {
    apex?: Partial<SpbTokenBoundTier>;
    resilient?: Partial<SpbTokenBoundTier>;
    local?: Partial<SpbTokenBoundTier>;
  };
  tierProfiles?: {
    apex?: Partial<SpbTierProfile>;
    resilient?: Partial<SpbTierProfile>;
    local?: Partial<SpbTierProfile>;
  };
}

export interface ConcreteSpbRuntimeConfig {
  stagnationThreshold: number;
  stagnationIntervalMs: number;
  enableSelfCorrectionPrompt: boolean;
  multiFileThreshold: number;
  duplicateReadThreshold: number;
  diffTimeoutMs: number;
  minResponseLength: number;
  retryStatusCodes: number[];
  strictCompletion: boolean;
  intentLedgerMode: "off" | "heuristic" | "apex_guided" | "apex_shadow";
  maxLedgerItems: number;
  maxReprompts: number;
  requireGitDiffEvidence: boolean;
  requireTestPassBeforeDone: boolean;
  tokenBounds: {
    apex: SpbTokenBoundTier;
    resilient: SpbTokenBoundTier;
    local: SpbTokenBoundTier;
  };
  tierProfiles: {
    apex: SpbTierProfile;
    resilient: SpbTierProfile;
    local: SpbTierProfile;
  };
}

export const DEFAULT_SPB_RUNTIME_CONFIG: ConcreteSpbRuntimeConfig = {
  stagnationThreshold: 2,
  stagnationIntervalMs: 120000,
  enableSelfCorrectionPrompt: true,
  multiFileThreshold: 3,
  duplicateReadThreshold: 3,
  diffTimeoutMs: 5000,
  minResponseLength: 20,
  retryStatusCodes: [400, 402, 408, 409, 429, 500, 502, 503, 504, 529],
  strictCompletion: false,
  intentLedgerMode: "heuristic",
  maxLedgerItems: 8,
  maxReprompts: 2,
  requireGitDiffEvidence: true,
  requireTestPassBeforeDone: true,
  tokenBounds: {
    apex: { high: 16384, medium: 12288, low: 8192 },
    resilient: { high: 8192, medium: 8192, low: 4096 },
    local: { high: 4096, medium: 4096, low: 2048 },
  },
  tierProfiles: {
    apex: { temperature: 0.2, reasoningEffort: "high" },
    resilient: { temperature: 0.2, reasoningEffort: "medium" },
    local: { temperature: 0.1, reasoningEffort: "low" },
  },
};

export interface TierConfig {
  version: string;
  defaults: {
    freeThreshold: number;
    cheapThreshold: number;
  };
  providerOverrides: ProviderTierOverride[];
  modelOverrides: ModelTierOverride[];
  freeProviders: string[];
  spbEnabled: boolean;
  onlyFreeTierModels?: boolean;
  tierModes?: TierModesConfig;
  tierWeights?: {
    apex: number;
    resilient: number;
    local: number;
  };
  tierModels?: TierModelsConfig;
  tierProviders?: TierProvidersConfig;
  cacheThreshold?: number;
  fallbackTimeout?: number;
  spbConfig?: SpbRuntimeConfig;
}

export interface ProviderTierOverride {
  provider: string;
  tier: ProviderTier;
}

export interface ModelTierOverride {
  provider: string;
  modelPattern: string;
  tier: ProviderTier;
}
