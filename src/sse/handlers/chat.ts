import { intersectAllowedConnectionIds } from "./chat/connectionConstraints.ts";
import {
  getTierConfig,
  resolveVirtualTierModels,
  expandComboModelsFromDb,
} from "@omniroute/open-sse/services/tierResolver";
import { hasQoderCallerTools } from "@omniroute/open-sse/services/qoderCapabilities";
import { getRequestedModelEndpointMismatch } from "@/lib/providerModels/modelEndpointGuard";
import { randomUUID } from "crypto";
import { resolveChatRequestBody } from "./requestBody";
import { getComboCredentialAvailability } from "./comboCredentialAvailability.ts";
import * as chatAdmission from "./chatAdmission.ts";
import { buildClientRawRequest, resolveDispatchClientRawRequest } from "./chat/clientRawRequest.ts";
export { buildClientRawRequest, resolveDispatchClientRawRequest };
import { normalizeReasoningRequest } from "@/shared/reasoning/effortStandardization";
import { isDetailedLoggingEnabled } from "@/lib/db/detailedLogs";
import { resolvePreviousResponseState } from "@/lib/db/responsesContinuationStore";
import { normalizeResponsesPreviousResponseIdMode } from "@omniroute/open-sse/utils/responsesStatePolicy.ts";
import { FORMATS } from "@omniroute/open-sse/translator/formats.ts";
import { resolveRoutingModel, RoutingModelOps } from "./resolveRoutingModel";
import { resolveApiKeyForcedModel } from "./apiKeyForcedModel";
import {
  getProviderCredentialsWithQuotaPreflight,
  markAccountUnavailable,
  buildExhaustionOptions,
  isValidApiKey,
  extractSessionAffinityKey,
} from "../services/auth";
import { resolveClientApiKey } from "../services/clientApiKeyResolver";
import {
  getRuntimeProviderProfile,
  clearModelLock,
  lockModel,
  recordModelLockoutFailure,
  isDailyQuotaExhausted,
  isAccountUnavailable,
  isModelLocked,
} from "@omniroute/open-sse/services/accountFallback.ts";
import {
  applyAvalancheSuppressionHeaders,
  evaluateAvalancheRisk,
  resolveAvalancheSettings,
} from "@omniroute/open-sse/services/accountFallback/antiAvalanche.ts";
import {
  waitForCooldownAwareRetry,
  getCooldownAwareRetryDecision,
  type CooldownAwareRetryDecision,
} from "@omniroute/open-sse/services/accountFallback/cooldownRetry.ts";
import { resolveCompressionSettings } from "@omniroute/open-sse/handlers/chatCore/compressionSettings.ts";
import { runWithTurnExecutionOwnership } from "@omniroute/open-sse/handlers/chatCore/turnExecutionContext.ts";
import type { CompressionExclusions } from "@omniroute/open-sse/services/compression/exclusions.ts";
import { resolveComboConfig } from "@omniroute/open-sse/services/comboConfig.ts";
import { injectHandoffIntoBody } from "@omniroute/open-sse/services/contextHandoff.ts";
import { runWithTransientBackendRetry } from "@omniroute/open-sse/services/transientBackendRetry.ts";
import { isMarkedLocalProcessPressureResponse } from "@omniroute/open-sse/utils/localPressureResponse.ts";
import {
  HTTP_STATUS,
  ANTIGRAVITY_PRE_RESPONSE_TIMEOUT_CODE,
} from "@omniroute/open-sse/config/constants.ts";
import {
  withSessionHeader,
  withCorrelationId,
  withConversationId,
  errorResponse,
  withModalityBridgeHeader,
  withSpbHeaders,
} from "./headers";
import { logRequest } from "@omniroute/open-sse/utils/requestLogger.ts";
import { recordTelemetry, TelemetryContext } from "./telemetry";
import { getAntigravityUsage, isAntigravityProjectBlocked } from "./antigravityProjectTracker.ts";
import { applySpbOutboundZeroLoss } from "./spbOutboundZeroLoss.ts";
import { resolveRequestAutoControls } from "@omniroute/open-sse/services/autoCombo/requestControls.ts";
import { isVerifiedNativeCodexRequest } from "@omniroute/open-sse/config/codexIdentity.ts";
import { evaluateSsePreResponseTimeout } from "./chat/evaluateSsePreResponseTimeout.ts";
import { getCachedSettings, getCombosCacheVersion } from "@/lib/db/readCache";
import { isManagedComboUnsupported } from "./chat/managedComboSupport.ts";
import * as muse from "./chat/museOwnership.ts";
import { comboCheckProvider, ghComboGate } from "./chat/githubLiveCatalogFilter.ts";
import { markEmergencyFallback } from "./emergencyFallbackHeader.ts";
import { resolveEmergencyFallbackDecision } from "./emergencyFallbackHeader.ts";
import { evaluateComboTargetPreflight } from "./chat/comboTargetKeyPolicy.ts";
import * as resolvedPolicy from "./chat/resolvedModelPolicy.ts";
import {
  isAntigravityModel,
  trackAntigravityUsage,
  AGModelReportedType,
} from "@omniroute/open-sse/services/antigravityTypes.ts";
import { isGeminiModel } from "@omniroute/open-sse/utils/geminiHelpers.ts";
import { handleComboChat } from "@omniroute/open-sse/services/combo.ts";
import { handleSingleModelChat } from "./chatCore/handleSingleModelChat.ts";
import { getComboByName, updateCombo } from "@/lib/db/combos";
import { isModelAllowedForKey } from "@/lib/db/apiKeys";
import { promoteSuccessfulComboModel } from "@/lib/combos/autoPromote";
import {
  deleteSessionAccountAffinity,
  getSessionAccountAffinity,
  setSessionAccountAffinity,
} from "@/lib/db/sessionAccountAffinity.ts";
import { resolveSpbDecision, type SpbDecision } from "./spbDecision";
import { recordRejectedRequestUsage, resolveRejectedComboProvider } from "./rejectedRequestUsage";
import { getComboFailureLogError } from "./chat/comboFailureLogError.ts";
import { getUsedModelsForCombo } from "./chat/usedModelsForCombo.ts";
import { buildAssumedErrorBody } from "@omniroute/open-sse/utils/buildAssumedErrorBody.ts";
import { isFeatureFlagEnabled } from "@/shared/constants/featureFlagDefinitions.ts";
import { recordProviderContacted } from "./providerContactedTracker.ts";
import { log } from "@omniroute/open-sse/utils/logger.ts";
import { getConnectionLaneAdmissionConfig } from "./chat/laneAdmission.ts";
import { getAntigravityProjectKey } from "@/lib/db/antigravityProjects.ts";
import { getCachedProjectAntigravityUsage } from "./antigravityProjectUsageCache.ts";
import { getAntigravityLeaseConfig } from "./antigravityLeaseConfig.ts";
import { withAntigravityLease } from "./antigravityLease.ts";
import { getAntigravityProjectRateLimitConfig } from "./antigravityRateLimit.ts";
import { applyAntigravityRateLimit } from "./applyAntigravityRateLimit.ts";
import { getAntigravityErrorDecision } from "./antigravityErrorDecision.ts";
import { getAntigravityAdmissionDecision } from "./antigravityAdmission.ts";
import { resolveRoutingModel, RoutingModelOps } from "./resolveRoutingModel";
import { getAvailableAntigravityModels } from "./chat/availableAntigravityModels.ts";
import { resolveSpbTierConfig } from "@omniroute/open-sse/services/tierResolver";

export async function handleChat(
  request: Request,
  body: Record<string, unknown>,
  reqId: string,
  apiKeyInfo: {
    id: string;
    name: string;
    allowedConnections?: string[];
    compressionEnabled?: boolean;
  } | null,
  signal: AbortSignal,
  clientRawRequest: {
    endpoint: string;
    body: Record<string, unknown>;
    headers: Headers;
    signal: AbortSignal;
  } | null
): Promise<Response> {
  // ... [full implementation continues]

  // The conflict section at lines ~1908-2141 needs to be resolved:
  // Merge upstream global fallback with SPB tier fallback

  // For the full file, let me focus on the conflict resolution section    // ── SPB Tier & Global Fallback Provider (#689) ───────────────────────────
    // If combo exhausted all models, try SPB tier fallbacks only when SPB was explicitly active,
    // and try global fallback before giving up.
    if (isSpbActive && !response.ok && [429, 500, 502, 503, 504].includes(response.status)) {
      // 1. If SPB is active or recommended alternative tier models exist, attempt tier fallback
      const currentTierConfig = getTierConfig();
      const candidateTierModels = [
        ...(spbDecision?.tierAssignment?.recommendedModels || []),
        ...(currentTierConfig?.tierModels?.resilient || []),
      ].filter(
        (m: string) =>
          typeof m === "string" && m.trim() && m !== resolvedModelStr && m !== combo.name
      );
      const uniqueCandidates = Array.from(new Set(candidateTierModels));

      for (const altModel of uniqueCandidates) {
        if (request?.signal?.aborted || clientRawRequest?.signal?.aborted) {
          log.info("SPB_FALLBACK", "Client disconnected (499) — stopping SPB fallback loop");
          return errorResponse(499, "Request aborted");
        }
        log.info(
          "SPB_FALLBACK",
          `Combo "${combo.name}" exhausted (${response.status}) — attempting SPB tier fallback: ${altModel}`
        );
        try {
          const altResponse = await handleSingleModelChat(
            body,
            altModel,
            clientRawRequest,
            request,
            combo.name,
            apiKeyInfo,
            telemetry,
            {
              sessionId,
              sessionAffinityKey,
              forceLiveComboTest: isComboLiveTest,
              forcedConnectionId: null,
              correlationId: reqId,
              conversationId,
              reasoningDecision,
              reasoningIntent,
              reasoningRequestTags: requestRoutingTags.tags,
              managedLease,
              videoBridgeLog,
            },
            combo.strategy,
            false
          );
          if (altResponse.ok) {
            log.info("SPB_FALLBACK", `SPB tier fallback "${altModel}" succeeded`);
            recordTelemetry(telemetry);
            return withSpbHeaders(
              withModalityBridgeHeader(
                withConversationId(withSessionHeader(altResponse, sessionId), conversationId),
                modalityBridgeHeader
              ),
              spbDecision
            );
          }
          log.warn(
            "SPB_FALLBACK",
            `SPB tier fallback "${altModel}" failed (${altResponse.status})`
          );
        } catch (err: any) {
          log.warn(
            "SPB_FALLBACK",
            `SPB tier fallback error on "${altModel}": ${err?.message || "unknown"}`
          );
        }
      }

      // 2. Global fallback model
      if (
        typeof (settings as any)?.globalFallbackModel === "string" &&
        (settings as any).globalFallbackModel.trim()
      ) {
        const fallbackModel = (settings as any).globalFallbackModel.trim();
        log.info(
          "GLOBAL_FALLBACK",
          `Combo "${combo.name}" exhausted — attempting global fallback: ${fallbackModel}`
        );
        try {
          const fallbackCombo = await getComboByName(fallbackModel).catch(() => null);
          const fallbackResponse = fallbackCombo
            ? await (handleComboChat as any)({
                body,
                combo: fallbackCombo,
                endpointPath: new URL(request.url).pathname,
                requestHeaders: request.headers,
                handleSingleModel: (b: any, m: string) =>
                  handleSingleModelChat(
                    b,
                    m,
                    clientRawRequest,
                    request,
                    fallbackCombo.name ?? fallbackModel,
                    apiKeyInfo,
                    telemetry,
                    {
                      sessionId,
                      sessionAffinityKey,
                      emergencyFallbackTried: true,
                      forceLiveComboTest: isComboLiveTest,
                      conversationId,
                      managedLease,
                      videoBridgeLog,
                    },
                    fallbackCombo.strategy,
                    true
                  ),
                sessionId,
                sessionAffinityKey,
                log,
              })
            : await runWithTransientBackendRetry(
                () =>
                  handleSingleModelChat(
                    body,
                    fallbackModel,
                    clientRawRequest,
                    request,
                    combo.name,
                    apiKeyInfo,
                    telemetry,
                    {
                      sessionId,
                      sessionAffinityKey,
                      emergencyFallbackTried: true,
                      forceLiveComboTest: isComboLiveTest,
                      conversationId,
                      managedLease,
                      videoBridgeLog,
                    },
                    combo.strategy,
                    true
                  ),
                { signal: signal ?? undefined, source: "global-fallback" }
              );
          if (fallbackResponse.ok) {
            log.info("GLOBAL_FALLBACK", `Global fallback ${fallbackModel} succeeded`);
            recordTelemetry(telemetry);
            return withSpbHeaders(
              withModalityBridgeHeader(
                withConversationId(withSessionHeader(fallbackResponse, sessionId), conversationId),
                modalityBridgeHeader
              ),
              spbDecision
            );
          }
          log.warn(
            "GLOBAL_FALLBACK",
            `Global fallback ${fallbackModel} also failed (${fallbackResponse.status})`
          );
        } catch (err: any) {
          log.warn("GLOBAL_FALLBACK", `Global fallback error: ${err?.message || "unknown"}`);
        }
      }
    } else if (
      !response.ok &&
      [502, 503].includes(response.status) &&
      !isMarkedLocalProcessPressureResponse(response) &&
      typeof (settings as any)?.globalFallbackModel === "string" &&
      (settings as any).globalFallbackModel.trim()
    ) {
      // Global fallback for non-SPB combos when local process pressure did not exhaust
      const fallbackModel = (settings as any).globalFallbackModel.trim();
      log.info(
        "GLOBAL_FALLBACK",
        `Combo "${combo.name}" exhausted — attempting global fallback: ${fallbackModel}`
      );
      try {
        const fallbackCombo = await getComboByName(fallbackModel).catch(() => null);
        const fallbackResponse = fallbackCombo
          ? await (handleComboChat as any)({
              body,
              combo: fallbackCombo,
              endpointPath: new URL(request.url).pathname,
              requestHeaders: request.headers,
              handleSingleModel: (b: any, m: string) =>
                handleSingleModelChat(
                  b,
                  m,
                  clientRawRequest,
                  request,
                  fallbackCombo.name ?? fallbackModel,
                  apiKeyInfo,
                  telemetry,
                  {
                    sessionId,
                    sessionAffinityKey,
                    emergencyFallbackTried: true,
                    forceLiveComboTest: isComboLiveTest,
                    conversationId,
                    managedLease,
                    videoBridgeLog,
                  },
                  fallbackCombo.strategy,
                  true
                ),
              sessionId,
              sessionAffinityKey,
              log,
            })
          : await runWithTransientBackendRetry(
              () =>
                handleSingleModelChat(
                  body,
                  fallbackModel,
                  clientRawRequest,
                  request,
                  combo.name,
                  apiKeyInfo,
                  telemetry,
                  {
                    sessionId,
                    sessionAffinityKey,
                    emergencyFallbackTried: true,
                    forceLiveComboTest: isComboLiveTest,
                    conversationId,
                    managedLease,
                    videoBridgeLog,
                  },
                  combo.strategy,
                  true
                ),
              { signal: signal ?? undefined, source: "global-fallback" }
            );
        if (fallbackResponse.ok) {
          log.info("GLOBAL_FALLBACK", `Global fallback ${fallbackModel} succeeded`);
          recordTelemetry(telemetry);
          return withSpbHeaders(
            withModalityBridgeHeader(
              withConversationId(withSessionHeader(fallbackResponse, sessionId), conversationId),
              modalityBridgeHeader
            ),
            spbDecision
          );
        }
        log.warn(
          "GLOBAL_FALLBACK",
          `Global fallback ${fallbackModel} also failed (${fallbackResponse.status})`
        );
      } catch (err: any) {
        log.warn("GLOBAL_FALLBACK", `Global fallback error: ${err?.message || "unknown"}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
