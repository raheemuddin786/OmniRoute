/**
 * accountFallback/hasPerModelQuota.ts — whether a provider locks model-by-model
 * instead of cooling the whole connection on failure.
 *
 * Leaf module: imports only from `src/shared/constants/providers` and
 * `open-sse/services/passthroughRegistry`, so it never participates in the
 * accountFallback ↔ perModelFailureScope import cycle.
 */
import {
  resolveProviderId,
  isLocalProvider,
  isSelfHostedChatProvider,
} from "../../../src/shared/constants/providers";
import { isRegistryPassthroughProvider } from "../passthroughRegistry.ts";

function isCompatibleProvider(provider: string | null | undefined): boolean {
  return (
    typeof provider === "string" &&
    (provider.startsWith("openai-compatible-") || provider.startsWith("anthropic-compatible-"))
  );
}

function getCanonicalLockProvider(provider: string): string {
  return resolveProviderId(provider);
}

/**
 * Returns true when the provider's failures should be scoped to a single model
 * rather than cooling the entire connection/account.
 */
export function hasPerModelQuota(
  provider: string | null | undefined,
  _model: string | null | undefined = null,
  connectionPassthroughModels?: boolean
): boolean {
  // Connection-level override takes precedence (e.g., user-configured ModelScope)
  if (typeof connectionPassthroughModels === "boolean") {
    return connectionPassthroughModels;
  }
  if (!provider) return false;
  const canonicalId = resolveProviderId(provider);
  if (getCanonicalLockProvider(canonicalId) === "antigravity") return true;
  if (getCanonicalLockProvider(canonicalId) === "codex") return true;
  if (canonicalId === "gemini" || canonicalId === "github") return true;
  if (canonicalId === "antigravity" || canonicalId === "agy") return true;
  // #18572: Qoder multiplexes every model behind one connection and answers a queued
  // request with `503 upstream_busy` naming the model that was queued. Treating that as a
  // connection cooldown parks every sibling model of the account, so it belongs on the
  // per-model allowlist instead.
  if (canonicalId === "qoder") return true;
  if (isRegistryPassthroughProvider(canonicalId)) return true;
  if (isCompatibleProvider(canonicalId)) return true;
  if (isLocalProvider(canonicalId) || isSelfHostedChatProvider(canonicalId)) return true;
  return false;
}
