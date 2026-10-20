/**
 * Governance identity resolution — REUSES the existing id scheme.
 *
 * The governance layer must NOT invent a parallel identity scheme: a
 * governance session key that differs from the routing/session key would make
 * the audit trail impossible to join with the rest of the system. This module
 * therefore resolves the session key from the SAME primitives the rest of the
 * codebase uses:
 *
 *  - `extractExternalSessionId(headers)` (`open-sse/services/sessionManager.ts`)
 *    — the client-supplied session id, normalized to `ext:<raw≤64>`.
 *  - `generateSessionId(body, {provider, connectionId})` (same file) — the
 *    SHA-256 conversation fingerprint (16 hex chars). This is the SAME value
 *    `open-sse/utils/stream.ts` computes for its cross-request tool-latency
 *    tracking, so a governance session lines up with that one.
 *
 *  The principal is the API-key id (`apiKeyInfo.id` → `String(...)`) — the
 *  value `chatCore.ts` already uses for `compressionPrincipalId` (the CCR
 *  tenancy boundary) and the `mcp_tool_audit.api_key_id` column.
 *
 *  CAVEAT (documented, not worked around): the sessionManager maps are
 *  in-memory with a 15-minute TTL and a 200-session cap, so a session can be
 *  EVICTED between two turns of the same conversation. A session-keyed
 *  governance policy (the loop breaker, the DEGRADED dedup) must therefore
 *  tolerate a cold start — the loop breaker's window simply begins empty
 *  again, and the DEGRADED event is re-emitted for the new session id. Neither
 *  is a correctness problem, and neither is worked around by inventing a
 *  stronger id.
 */

import { extractExternalSessionId, generateSessionId } from "../services/sessionManager.ts";

export interface GovernanceIdentityInput {
  /** The request body (used for the conversation fingerprint). */
  body?: unknown;
  /**
   * Request headers (used for the external session id).
   *
   * Both shapes are accepted: a `Headers` instance (with `.get()`) and the
   * plain lowercased record the repo's `clientRawRequest` envelope carries
   * (`Object.fromEntries(request.headers.entries())`). The record shape has no
   * `.get()`, so `extractExternalSessionId` alone would silently return null
   * for it — hence the adapter below.
   */
  headers?: Headers | Record<string, unknown> | null | undefined;
  /** Provider — part of the session fingerprint. */
  provider?: string | null;
  /** Connection id — part of the session fingerprint. */
  connectionId?: string | null;
  /**
   * Fallback key when neither the header nor the body yields a fingerprint
   * (e.g. a body with no model, no system prompt and no user message).
   * Callers pass their existing per-request id.
   */
  fallback?: string | null;
}

export interface GovernanceIdentity {
  /** The session key. Never null — falls back to `fallback`, then to a literal. */
  sessionId: string;
  /** The API-key id when known. */
  principalId?: string;
  /** How the session key was resolved. Useful for observability. */
  source: "external" | "fingerprint" | "fallback" | "anonymous";
}

/**
 * Adapt either header shape to the `.get()` interface
 * `extractExternalSessionId` expects.
 *
 * The `clientRawRequest` envelope stores headers as a lowercased plain record
 * (`Object.fromEntries(request.headers.entries())`), so a record lookup must
 * be case-insensitive to match the `Headers` behaviour.
 */
function toHeaderReader(
  headers: GovernanceIdentityInput["headers"]
): { get?: (name: string) => string | null } | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return headers as Headers;
  const record = headers as Record<string, unknown>;
  const lowercased = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") lowercased.set(key.toLowerCase(), value);
  }
  return {
    get: (name: string) => lowercased.get(name.toLowerCase()) ?? null,
  };
}

/** The API-key id, when the caller knows it. Never throws. */
function resolvePrincipalId(
  apiKeyInfo?: { id?: string | number | null } | null
): string | undefined {
  try {
    if (apiKeyInfo?.id === undefined || apiKeyInfo?.id === null) return undefined;
    return String(apiKeyInfo.id);
  } catch {
    return undefined;
  }
}

/** Assemble the identity, omitting the principal when it is unknown. */
function buildIdentity(
  sessionId: string,
  source: GovernanceIdentity["source"],
  principalId: string | undefined
): GovernanceIdentity {
  return { sessionId, source, ...(principalId ? { principalId } : {}) };
}

/**
 * Resolve the governance session key + principal.
 *
 * Never throws — a resolution failure degrades to the fallback key so the
 * request still proceeds (fail OPEN).
 */
export function resolveGovernanceIdentity(
  input: GovernanceIdentityInput,
  apiKeyInfo?: { id?: string | number | null } | null
): GovernanceIdentity {
  const principalId = resolvePrincipalId(apiKeyInfo);

  try {
    const external = extractExternalSessionId(toHeaderReader(input.headers));
    if (external) return buildIdentity(external, "external", principalId);

    const fingerprint = generateSessionId(
      (input.body ?? null) as Parameters<typeof generateSessionId>[0],
      {
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      }
    );
    if (fingerprint) return buildIdentity(fingerprint, "fingerprint", principalId);

    if (input.fallback) return buildIdentity(input.fallback, "fallback", principalId);

    return buildIdentity("anonymous", "anonymous", principalId);
  } catch {
    // Fail OPEN: an identity resolution failure must not break the request.
    return buildIdentity(input.fallback || "anonymous", "fallback", principalId);
  }
}
