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

export const DEFAULT_SPB_TIER_MODELS: TierModelsConfig = {
  apex: ["claude-3-5-sonnet", "gpt-4o", "claude-opus-5-5"],
  resilient: ["claude-3-5-sonnet", "gpt-4o-mini", "deepseek-coder", "gemini-1-5-pro"],
  local: ["llama-3-8b-instruct", "mistral-7b", "ollama-local"],
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
  tierWeights?: {
    apex: number;
    resilient: number;
    local: number;
  };
  tierModels?: TierModelsConfig;
  cacheThreshold?: number;
  fallbackTimeout?: number;
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
