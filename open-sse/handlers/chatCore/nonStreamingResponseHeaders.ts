/**
 * chatCore non-streaming success response headers (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's non-streaming success path: build the response header map for a
 * cache-MISS JSON response — the static Content-Type + cache marker, the OmniRoute meta headers
 * (provider/model/latency/usage/cost/request-id), and the optional compression header. Pure builder
 * (returns a fresh map; only mutates the map it owns). Behaviour is byte-identical to the previous
 * inline block, including `latencyMs: now - startTime`.
 */
import { OMNIROUTE_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { attachOmniRouteMetaHeaders as defaultAttachMeta } from "@/domain/omnirouteResponseMeta";

export function buildNonStreamingResponseHeaders(
  args: {
    provider: string | null | undefined;
    model: string | null | undefined;
    startTime: number;
    responseUsage: Record<string, unknown> | null | undefined;
    estimatedCost: number;
    requestId: string | null | undefined;
    compressionResponseMeta?: string | null | undefined;
    comboStrategy?: string | null | undefined;
    fallbackAttempts?: number;
    compactionMeta?: {
      compressed?: boolean;
      type?: "proactive" | "last-resort" | "both";
      tokensOriginal?: number;
      tokensFinal?: number;
      layers?: string[];
      toolsTruncated?: number;
    } | null;
    toolsTruncated?: number;
  },
  deps: { attachOmniRouteMetaHeaders: typeof defaultAttachMeta; now: () => number } = {
    attachOmniRouteMetaHeaders: defaultAttachMeta,
    now: Date.now,
  }
): Record<string, string> {
  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    [OMNIROUTE_RESPONSE_HEADERS.cache]: "MISS",
  };
  deps.attachOmniRouteMetaHeaders(responseHeaders, {
    provider: args.provider,
    model: args.model,
    cacheHit: false,
    latencyMs: deps.now() - args.startTime,
    usage: args.responseUsage,
    costUsd: args.estimatedCost,
    requestId: args.requestId,
    strategy: args.comboStrategy ?? "single",
    ...(args.fallbackAttempts !== undefined ? { fallbackAttempts: args.fallbackAttempts } : {}),
  });
  if (args.compressionResponseMeta) {
    responseHeaders[OMNIROUTE_RESPONSE_HEADERS.compression] = args.compressionResponseMeta;
  }
  if (args.compactionMeta?.compressed) {
    responseHeaders[OMNIROUTE_RESPONSE_HEADERS.contextCompressed] = "true";
    if (args.compactionMeta.type) {
      responseHeaders[OMNIROUTE_RESPONSE_HEADERS.compactionType] = args.compactionMeta.type;
    }
    if (typeof args.compactionMeta.tokensOriginal === "number") {
      responseHeaders[OMNIROUTE_RESPONSE_HEADERS.tokensOriginal] = String(
        args.compactionMeta.tokensOriginal
      );
    }
    if (typeof args.compactionMeta.tokensFinal === "number") {
      responseHeaders[OMNIROUTE_RESPONSE_HEADERS.tokensFinal] = String(
        args.compactionMeta.tokensFinal
      );
    }
    if (Array.isArray(args.compactionMeta.layers) && args.compactionMeta.layers.length > 0) {
      responseHeaders[OMNIROUTE_RESPONSE_HEADERS.compactionLayers] =
        args.compactionMeta.layers.join(",");
    }
  }
  const effectiveToolsTruncated = args.toolsTruncated ?? args.compactionMeta?.toolsTruncated;
  if (typeof effectiveToolsTruncated === "number" && effectiveToolsTruncated > 0) {
    responseHeaders[OMNIROUTE_RESPONSE_HEADERS.toolsTruncated] = String(effectiveToolsTruncated);
  }
  return responseHeaders;
}
