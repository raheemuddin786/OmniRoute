import { LOCAL_PROVIDERS } from "@/shared/constants/providers";
import { isVisionModelId } from "@/shared/constants/visionModels";

export type SpbTierKey = "apex" | "resilient" | "local";

export type CapabilityFilterKey = "all" | "apex" | "resilient" | "local" | "tools" | "vision";

export interface ModelCapabilities {
  isApexReasoning: boolean;
  isResilient: boolean;
  isLocalEngine: boolean;
  hasToolCalling: boolean;
  hasVision: boolean;
  contextLength?: number;
}

export interface TierSelectableModel {
  id: string;
  name: string;
  fullValue: string;
  providerId: string;
  providerAlias: string;
  providerName: string;
  capabilities: ModelCapabilities;
  isConfigured: boolean;
  isCombo?: boolean;
  comboStrategy?: string;
  comboModels?: string[];
  comboDescription?: string;
}

const APEX_REASONING_REGEX =
  /(o1|o3|r1|reason|reasoning|thinking|opus|3[.-]7|sonnet-4|claude-4|qwq|gemini-2\.0-flash-thinking|gemini-3|command-a-reasoning)/i;

const RESILIENT_EXECUTION_REGEX =
  /(sonnet|gpt-4o|deepseek-coder|qwen2\.5-coder|gemini-1[.-]5|gemini-2|nemotron|stepfun|glm|command-a-plus|codex|claude-3)/i;

const LOCAL_MODEL_FAMILY_REGEX =
  /(llama|mistral|qwen|phi|deepseek-coder:?|gemma|nomic|bge|ollama|local|vicuna|starcoder)/i;

const LOCAL_PROVIDER_PREFIXES = [
  "ollama",
  "lm-studio",
  "lmstudio",
  "vllm",
  "localai",
  "jan",
  "docker-model-runner",
  "mlx",
  "local",
];

export function isLocalEngineProvider(providerId: string, urlOrHost?: string): boolean {
  if (!providerId) return false;
  const pLower = providerId.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOCAL_PROVIDERS, pLower)) {
    return true;
  }
  if (LOCAL_PROVIDER_PREFIXES.some((prefix) => pLower.includes(prefix))) {
    return true;
  }
  if (urlOrHost) {
    const hostLower = urlOrHost.toLowerCase();
    return (
      hostLower.includes("localhost") ||
      hostLower.includes("127.0.0.1") ||
      hostLower.includes("::1") ||
      hostLower.includes("0.0.0.0")
    );
  }
  return false;
}

export function detectModelCapabilities(
  providerId: string,
  model: {
    id: string;
    name?: string;
    toolCalling?: boolean;
    supportsReasoning?: boolean;
    alwaysReasons?: boolean;
    supportsVision?: boolean;
    contextLength?: number;
  },
  urlOrHost?: string
): ModelCapabilities {
  const modelId = model.id || "";
  const modelName = model.name || modelId;
  const isLocalProvider = isLocalEngineProvider(providerId, urlOrHost);
  const isLocalFamily =
    LOCAL_MODEL_FAMILY_REGEX.test(modelId) || LOCAL_MODEL_FAMILY_REGEX.test(modelName);

  const isLocalEngine = isLocalProvider || isLocalFamily;

  const isApexReasoning =
    model.supportsReasoning === true ||
    model.alwaysReasons === true ||
    APEX_REASONING_REGEX.test(modelId) ||
    APEX_REASONING_REGEX.test(modelName);

  const hasToolCalling =
    model.toolCalling === true ||
    (!isLocalProvider && !/(embedding|tts|rerank|diffusion|whisper)/i.test(modelId));

  const isResilient =
    !isLocalProvider &&
    (hasToolCalling ||
      (model.contextLength ?? 0) >= 32000 ||
      RESILIENT_EXECUTION_REGEX.test(modelId) ||
      RESILIENT_EXECUTION_REGEX.test(modelName));

  const hasVision =
    model.supportsVision === true ||
    isVisionModelId(modelId) ||
    isVisionModelId(`${providerId}/${modelId}`);

  return {
    isApexReasoning,
    isResilient,
    isLocalEngine,
    hasToolCalling,
    hasVision,
    contextLength: model.contextLength,
  };
}

export function detectComboCapabilities(combo: {
  id?: string;
  name?: string;
  strategy?: string;
  models?: Array<string | { model?: string; providerId?: string }>;
  description?: string;
  computed_context_length?: number;
}): ModelCapabilities {
  const comboName = combo.name || combo.id || "";
  const comboDesc = combo.description || "";
  const memberModelStrings = (Array.isArray(combo.models) ? combo.models : []).map((m) =>
    typeof m === "string" ? m : m?.model || ""
  );

  const hasApexMember = memberModelStrings.some((m) => APEX_REASONING_REGEX.test(m));
  const nameMatchesApex =
    APEX_REASONING_REGEX.test(comboName) ||
    /apex|reasoning|reasoner|thought|thinking|deep-think/i.test(comboName) ||
    /apex|reasoning|reasoner|thought|thinking/i.test(comboDesc);

  const isApexReasoning = hasApexMember || nameMatchesApex;

  const hasResilientMember = memberModelStrings.some((m) => RESILIENT_EXECUTION_REGEX.test(m));
  const isResilient = memberModelStrings.length >= 1 || hasResilientMember;

  const allLocal =
    memberModelStrings.length > 0 &&
    memberModelStrings.every(
      (m) =>
        LOCAL_MODEL_FAMILY_REGEX.test(m) ||
        m.toLowerCase().startsWith("ollama") ||
        m.toLowerCase().startsWith("local")
    );

  const hasLocalMember = memberModelStrings.some(
    (m) =>
      LOCAL_MODEL_FAMILY_REGEX.test(m) ||
      m.toLowerCase().startsWith("ollama") ||
      m.toLowerCase().startsWith("local") ||
      /(flash|lite|mini|free|small|turbo|fast|haiku|edge)/i.test(m)
  );

  const nameMatchesLocal =
    LOCAL_MODEL_FAMILY_REGEX.test(comboName) ||
    /local|edge|ollama|offline|fast|speed|quick|mini|lite|free|refactor|small/i.test(comboName) ||
    /local|edge|ollama|offline|fast|speed|quick|mini|lite|free|refactor|small/i.test(comboDesc);

  const isLocalEngine = allLocal || hasLocalMember || nameMatchesLocal;

  const hasToolCalling = !memberModelStrings.every((m) =>
    /(embedding|tts|rerank|diffusion|whisper)/i.test(m)
  );

  const hasVision = memberModelStrings.some((m) => isVisionModelId(m));

  return {
    isApexReasoning,
    isResilient,
    isLocalEngine,
    hasToolCalling,
    hasVision,
    contextLength:
      typeof combo.computed_context_length === "number" && combo.computed_context_length > 0
        ? combo.computed_context_length
        : undefined,
  };
}

export function isModelEligibleForTier(tier: SpbTierKey, caps: ModelCapabilities): boolean {
  switch (tier) {
    case "apex":
      return caps.isApexReasoning;
    case "resilient":
      return caps.isResilient || caps.hasToolCalling;
    case "local":
      return caps.isLocalEngine;
    default:
      return true;
  }
}

export function matchesCapabilityFilter(
  filter: CapabilityFilterKey,
  caps: ModelCapabilities,
  tier: SpbTierKey
): boolean {
  switch (filter) {
    case "all":
      return isModelEligibleForTier(tier, caps);
    case "apex":
      return caps.isApexReasoning;
    case "resilient":
      return caps.isResilient;
    case "local":
      return caps.isLocalEngine;
    case "tools":
      return caps.hasToolCalling;
    case "vision":
      return caps.hasVision;
    default:
      return true;
  }
}

export function getTierColorClass(tier: SpbTierKey): {
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  headerText: string;
  accent: string;
} {
  switch (tier) {
    case "apex":
      return {
        badgeBg: "bg-indigo-500/10",
        badgeBorder: "border-indigo-500/20",
        badgeText: "text-indigo-400",
        headerText: "text-indigo-400",
        accent: "indigo",
      };
    case "resilient":
      return {
        badgeBg: "bg-blue-500/10",
        badgeBorder: "border-blue-500/20",
        badgeText: "text-blue-400",
        headerText: "text-blue-400",
        accent: "blue",
      };
    case "local":
      return {
        badgeBg: "bg-emerald-500/10",
        badgeBorder: "border-emerald-500/20",
        badgeText: "text-emerald-400",
        headerText: "text-emerald-400",
        accent: "emerald",
      };
  }
}
