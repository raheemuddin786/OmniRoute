/**
 * phaseComboSetup — the first extracted phase of handleComboChat (combo.ts).
 *
 * Resolves the per-request combo setup BEFORE dispatch: routing strategy, context-relay
 * config, resilience settings, universal-handoff config, server-side context-cache pinning
 * (which rewrites ctx.body), combo agent middleware (also rewrites ctx.body), the config
 * cascade, the per-target timeout, and the reasoning-token-buffer flag. Behaviour is
 * byte-identical to the inline block it replaces — it just reads/writes via ComboContext.
 *
 * See _tasks/quality/2026-06-19-DESIGN-godfiles-decomposition.md §4.
 */
import { normalizeRoutingStrategy } from "../../../src/shared/constants/routingStrategies.ts";
import {
  resolveContextRelayConfig,
  resolveUniversalHandoffConfig,
  SKIP_UNIVERSAL_HANDOFF_FLAG,
} from "../contextHandoff.ts";
import { getLastSessionModel } from "../../../src/lib/db/contextHandoffs.ts";
import { scopeHandoffSessionId } from "./handoffSessionScope.ts";
// import { applyComboAgentMiddleware } from "../comboAgentMiddleware.ts"; // Temporarily unused
import { resolveComboSetupConfig, resolveComboTargetTimeoutMsForCombo } from "../comboConfig.ts";
import { resolveResilienceSettings } from "../../../src/lib/resilience/settings";
import { FETCH_TIMEOUT_MS } from "../../config/constants.ts";
import { deriveComboSessionKey } from "./autoStrategy.ts";
import type { ComboContext, ComboSetup } from "./comboTypes.ts";

function resolveContextCachePin(ctx: ComboContext): {
  effectiveSessionId: string | null;
  pinnedModel: string | null;
} {
  const { combo, relayOptions, log } = ctx;
  const isCacheProtected = Boolean(combo.context_cache_protection);
  const effectiveSessionId: string | null = isCacheProtected
    ? scopeHandoffSessionId(
        relayOptions?.sessionId ?? deriveComboSessionKey(ctx.body),
        relayOptions?.apiKeyId
      )
    : null;
  let pinnedModel: string | null = null;
  if (
    isCacheProtected &&
    effectiveSessionId &&
    !(ctx.body as Record<string, unknown>)?.[SKIP_UNIVERSAL_HANDOFF_FLAG]
  ) {
    const pinned = getLastSessionModel(effectiveSessionId, combo.name);
    if (pinned) {
      ctx.body = { ...ctx.body, model: pinned };
      pinnedModel = pinned;
      log.info("COMBO", `[#401] Context cache: pinned model=${pinned} (server-side)`);
    }
  }
  return { effectiveSessionId, pinnedModel };
}

export function phaseComboSetup(ctx: ComboContext): ComboSetup {
  const { combo, settings, relayOptions } = ctx;

  const strategy = normalizeRoutingStrategy(combo.strategy || "priority");
  const relayConfig = getStrategyTraits(strategy).contextRelay
    ? resolveContextRelayConfig(relayOptions?.config || null)
    : null;

  const resilienceSettings = settings
    ? resolveResilienceSettings(settings)
    : resolveResilienceSettings({});

  const universalHandoffConfig = combo.skipUniversalHandoff
    ? null
    : resolveUniversalHandoffConfig(combo.universal_handoff_config);

  const { effectiveSessionId, pinnedModel } = resolveContextCachePin(ctx);

  const clientRequestedStream =
    relayOptions?.stream === true || (ctx.body as Record<string, unknown>)?.stream === true;

  const config = resolveComboSetupConfig(combo, settings);

  const comboTargetTimeoutMs = resolveComboTargetTimeoutMsForCombo(
    config,
    FETCH_TIMEOUT_MS,
    strategy,
    resilienceSettings.comboCooldownWait
  );
  const comboTimeoutMs = config.comboTimeoutMs || 0;
  const reasoningTokenBufferEnabled = config.reasoningTokenBufferEnabled !== false;

  return {
    strategy,
    relayConfig,
    resilienceSettings,
    universalHandoffConfig,
    effectiveSessionId,
    pinnedModel,
    clientRequestedStream,
    config,
    comboTargetTimeoutMs,
    comboTimeoutMs,
    reasoningTokenBufferEnabled,
  };
}
