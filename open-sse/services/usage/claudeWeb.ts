/**
 * usage/claudeWeb.ts — Claude Web (cookie-based session) 5-hour rolling quota tracker.
 *
 * Claude Web does not expose a public read-only quota counter endpoint without risking
 * anti-bot / Cloudflare challenges or burning precious turn allowance with fake prompts.
 * This fetcher computes the truthful 5-hour rolling usage metrics directly from the local
 * telemetry in storage.sqlite (usage_history table), calculating:
 *  - 5-hour rolling requests (typical capacity: 45 messages per 5h window)
 *  - 5-hour rolling tokens (estimated ~200k tokens per 5h window)
 *  - Estimated window reset timestamp (from the oldest request in the active 5h window)
 */

import { getDbInstance } from "@/lib/db/core";
import { DEFAULT_QUOTA_WINDOW_MS } from "../providerDefaultRateLimit.ts";

export interface ClaudeWebUsageResult {
  plan: string;
  quotas: {
    rolling_5h_requests: {
      used: number;
      total: number;
      remaining: number;
      remainingPercentage: number;
      resetAt: string | null;
      unlimited: boolean;
      fractionReported: boolean;
      quotaSource: string;
    };
    rolling_5h_tokens: {
      used: number;
      total: number;
      remaining: number;
      remainingPercentage: number;
      resetAt: string | null;
      unlimited: boolean;
      fractionReported: boolean;
      quotaSource: string;
    };
  };
  message?: string | null;
}

const CLAUDE_WEB_ESTIMATED_WINDOW_REQUESTS = 45;
const CLAUDE_WEB_ESTIMATED_WINDOW_TOKENS = 200_000;

export async function getClaudeWebUsage(
  connectionId: string | undefined,
  _connection?: Record<string, unknown>
): Promise<ClaudeWebUsageResult | { message: string }> {
  if (!connectionId) {
    return { message: "Connection ID required to calculate Claude Web rolling quota" };
  }

  try {
    const db = getDbInstance();
    const windowStartMs = Date.now() - DEFAULT_QUOTA_WINDOW_MS;
    const windowStartIso = new Date(windowStartMs).toISOString();

    const sql = `
      SELECT
        COUNT(*) AS requestCount,
        COALESCE(SUM(tokens_input + tokens_output), 0) AS totalTokens,
        MIN(timestamp) AS earliestInWindow
      FROM usage_history
      WHERE connection_id = ?
        AND timestamp >= ?
        AND success = 1
    `;

    const row = db.prepare(sql).get(connectionId, windowStartIso) as
      | {
          requestCount?: number;
          totalTokens?: number;
          earliestInWindow?: string | null;
        }
      | undefined;

    const usedRequests = Number(row?.requestCount ?? 0);
    const usedTokens = Number(row?.totalTokens ?? 0);

    let resetAtIso: string | null = null;
    if (row?.earliestInWindow) {
      const earliestMs = Date.parse(row.earliestInWindow);
      if (Number.isFinite(earliestMs)) {
        resetAtIso = new Date(earliestMs + DEFAULT_QUOTA_WINDOW_MS).toISOString();
      }
    }

    const remainingRequests = Math.max(0, CLAUDE_WEB_ESTIMATED_WINDOW_REQUESTS - usedRequests);
    const remainingReqPct = Math.round(
      (remainingRequests / CLAUDE_WEB_ESTIMATED_WINDOW_REQUESTS) * 100
    );

    const remainingTokens = Math.max(0, CLAUDE_WEB_ESTIMATED_WINDOW_TOKENS - usedTokens);
    const remainingTokenPct = Math.round(
      (remainingTokens / CLAUDE_WEB_ESTIMATED_WINDOW_TOKENS) * 100
    );

    return {
      plan: "Claude Web (Pro/Team)",
      quotas: {
        rolling_5h_requests: {
          used: usedRequests,
          total: CLAUDE_WEB_ESTIMATED_WINDOW_REQUESTS,
          remaining: remainingRequests,
          remainingPercentage: remainingReqPct,
          resetAt: resetAtIso,
          unlimited: false,
          fractionReported: true,
          quotaSource: "localTelemetry",
        },
        rolling_5h_tokens: {
          used: usedTokens,
          total: CLAUDE_WEB_ESTIMATED_WINDOW_TOKENS,
          remaining: remainingTokens,
          remainingPercentage: remainingTokenPct,
          resetAt: resetAtIso,
          unlimited: false,
          fractionReported: true,
          quotaSource: "localTelemetry",
        },
      },
    };
  } catch (error) {
    return {
      message: `Failed to compute Claude Web usage: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
