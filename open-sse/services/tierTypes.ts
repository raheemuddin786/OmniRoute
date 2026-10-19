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
  apex: [
    "claude-3-7-sonnet",
    "deepseek-reasoner",
    "gemini-3.7-flash-high",
    "claude-opus-4-6-thinking",
    "deepseek-ai/deepseek-v4-pro-0813",
    "command-a-reasoning-08-2025",
    "o1",
    "o3-mini",
  ],
  resilient: [
    "claude-3-5-sonnet",
    "claude-sonnet-4-6",
    "gemini-2.5-flash",
    "gemini-pro-agent",
    "deepseek-chat",
    "deepseek-ai/deepseek-v4-flash-0731",
    "moonshotai/kimi-k3",
    "command-r-plus-08-2024",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  local: [
    "llama-3-8b-instruct",
    "llama-3.3-70b-instruct",
    "llama-3.1-8b-instruct",
    "qwen2.5-coder-32b-instruct",
    "deepseek-r1:8b",
    "mistral-7b",
    "ollama-local",
  ],
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
