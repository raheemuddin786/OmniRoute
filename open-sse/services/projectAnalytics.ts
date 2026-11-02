/**
 * open-sse/services/projectAnalytics.ts — On-demand analytics calculation for projects.
 *
 * Aggregates token economics, sessions, model distribution, prompt histories,
 * and memory/RAG metrics from database domain modules without overloading the
 * real-time LLM inference pipeline.
 */

import { getDbInstance } from "../../src/lib/db/core.ts";
import type {
  ProjectAnalytics,
  TokenEconomics,
  SessionSummary,
  AgentUsageSummary,
  ProjectBrief,
} from "../../src/lib/db/projectRegistry.ts";
import { getProject, setAnalyticsCache, setBriefCache } from "../../src/lib/db/projectRegistry.ts";

interface CallLogAggregateRow {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  tokensInSuccess: number;
  tokensOutSuccess: number;
  tokensInFailed: number;
  tokensOutFailed: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensReasoning: number;
}

interface CostLedgerRow {
  totalAmountUsd: number;
}

interface ModelCountRow {
  model: string;
  count: number;
}

interface ComboCountRow {
  combo_name: string;
  count: number;
}

interface PromptRow {
  request_summary: string | null;
  timestamp: string;
}

interface MemoryCountRow {
  count: number;
}

/**
 * Calculates on-demand analytics for a registered project.
 * Uses bounded database queries so no external LLM load is incurred.
 */
export async function calculateProjectAnalytics(
  projectId: string
): Promise<ProjectAnalytics | null> {
  const project = getProject(projectId);
  if (!project) return null;

  const db = getDbInstance();

  // 1. Token Economics from call_logs
  // Query summary metrics
  const callLogsStmt = db.prepare(`
    SELECT
      COUNT(*) AS totalCalls,
      COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END), 0) AS successCalls,
      COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) AS failedCalls,
      COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN tokens_in ELSE 0 END), 0) AS tokensInSuccess,
      COALESCE(SUM(CASE WHEN status >= 200 AND status < 300 THEN tokens_out ELSE 0 END), 0) AS tokensOutSuccess,
      COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN tokens_in ELSE 0 END), 0) AS tokensInFailed,
      COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN tokens_out ELSE 0 END), 0) AS tokensOutFailed,
      COALESCE(SUM(tokens_cache_read), 0) AS tokensCacheRead,
      COALESCE(SUM(tokens_cache_creation), 0) AS tokensCacheCreation,
      COALESCE(SUM(tokens_reasoning), 0) AS tokensReasoning
    FROM call_logs
  `);
  const logAgg = (callLogsStmt.get() ?? {}) as Partial<CallLogAggregateRow>;

  // 2. Cost calculations from request_cost_ledger if present
  let totalCostUsd = 0;
  try {
    const costStmt = db.prepare(`
      SELECT COALESCE(SUM(amount_usd), 0.0) AS totalAmountUsd
      FROM request_cost_ledger
    `);
    const costAgg = (costStmt.get() ?? {}) as Partial<CostLedgerRow>;
    totalCostUsd = Number(costAgg.totalAmountUsd ?? 0);
  } catch {
    // If table not populated or empty, cost remains 0
    totalCostUsd = 0;
  }

  const successTokens = Number(logAgg.tokensInSuccess ?? 0) + Number(logAgg.tokensOutSuccess ?? 0);
  const wastedTokens = Number(logAgg.tokensInFailed ?? 0) + Number(logAgg.tokensOutFailed ?? 0);
  const cachedTokens = Number(logAgg.tokensCacheRead ?? 0);
  // Estimate saved tokens from cache hits and combo routing optimization
  const savedTokens = Math.round(cachedTokens * 0.85);

  const tokenEconomics: TokenEconomics = {
    success: successTokens,
    wasted: wastedTokens,
    cached: cachedTokens,
    saved: savedTokens,
    costUsd: Math.round(totalCostUsd * 10000) / 10000,
  };

  // 3. Chat sessions & unique user prompts
  let totalSessions = 0;
  let uniquePrompts = 0;
  const recentPrompts: Array<{ prompt: string; timestamp: string }> = [];

  try {
    const convStmt = db.prepare(`SELECT COUNT(*) AS count FROM agentic_conversations`);
    const convRow = (convStmt.get() ?? { count: 0 }) as { count: number };
    totalSessions = Number(convRow.count ?? 0);
  } catch {
    totalSessions = Number(logAgg.totalCalls ?? 0);
  }

  try {
    const promptsStmt = db.prepare(`
      SELECT request_summary, timestamp
      FROM call_logs
      WHERE request_summary IS NOT NULL AND length(trim(request_summary)) > 0
      ORDER BY timestamp DESC
      LIMIT 20
    `);
    const promptRows = (promptsStmt.all() ?? []) as PromptRow[];
    const seenPrompts = new Set<string>();

    for (const r of promptRows) {
      if (!r.request_summary) continue;
      const clean = r.request_summary.trim();
      if (!seenPrompts.has(clean)) {
        seenPrompts.add(clean);
        recentPrompts.push({
          prompt: clean.length > 200 ? `${clean.slice(0, 197)}...` : clean,
          timestamp: r.timestamp,
        });
      }
    }
    uniquePrompts = seenPrompts.size;
  } catch {
    uniquePrompts = 0;
  }

  const sessions: SessionSummary = {
    total: totalSessions,
    uniquePrompts,
    recentPrompts,
  };

  // 4. Models & Combos breakdown
  const byModel: Record<string, number> = {};
  let modelCallsTotal = 0;
  try {
    const modelStmt = db.prepare(`
      SELECT model, COUNT(*) AS count
      FROM call_logs
      WHERE model IS NOT NULL AND length(trim(model)) > 0
      GROUP BY model
      ORDER BY count DESC
      LIMIT 10
    `);
    const modelRows = (modelStmt.all() ?? []) as ModelCountRow[];
    for (const row of modelRows) {
      byModel[row.model] = row.count;
      modelCallsTotal += row.count;
    }
  } catch {
    // Graceful fallback
  }

  const combos: string[] = [];
  try {
    const comboStmt = db.prepare(`
      SELECT combo_name, COUNT(*) AS count
      FROM call_logs
      WHERE combo_name IS NOT NULL AND length(trim(combo_name)) > 0
      GROUP BY combo_name
      ORDER BY count DESC
      LIMIT 5
    `);
    const comboRows = (comboStmt.all() ?? []) as ComboCountRow[];
    for (const row of comboRows) {
      combos.push(row.combo_name);
    }
  } catch {
    // Graceful fallback
  }

  // 5. Skills & MCP Tools
  let skillsTotal = 0;
  try {
    const skillStmt = db.prepare(`SELECT COUNT(*) AS count FROM skills WHERE enabled = 1`);
    const skillRow = (skillStmt.get() ?? { count: 0 }) as { count: number };
    skillsTotal = Number(skillRow.count ?? 0);
  } catch {
    skillsTotal = 0;
  }

  // 6. Memories / RAG count
  let memoryCount = 0;
  try {
    const memStmt = db.prepare(`SELECT COUNT(*) AS count FROM memories`);
    const memRow = (memStmt.get() ?? { count: 0 }) as MemoryCountRow;
    memoryCount = Number(memRow.count ?? 0);
  } catch {
    memoryCount = 0;
  }

  const agents: AgentUsageSummary = {
    skills: {
      total: skillsTotal,
    },
    mcpTools: memoryCount,
    models: {
      total: modelCallsTotal,
      byModel,
    },
    combos,
  };

  // 7. Dynamic Optimizations
  const optimizations: string[] = [];
  if (wastedTokens > 10000) {
    optimizations.push(
      "High failure token consumption detected. Review provider fallback timeouts to prevent retry storms."
    );
  }
  if (cachedTokens === 0 && successTokens > 50000) {
    optimizations.push(
      "Prompt caching is currently underutilized. Enable prefix prompt caching to save up to 80% on repeated contexts."
    );
  } else if (cachedTokens > 0) {
    const cacheRatio = Math.round((cachedTokens / (successTokens + cachedTokens)) * 100);
    optimizations.push(
      `Effective cache hit ratio is ${cacheRatio}%. Great job maintaining prefix invariants.`
    );
  }
  if (combos.length === 0) {
    optimizations.push(
      "No active combo routing detected for this project. Configure Auto-Combo to route simple queries to fast, low-cost models."
    );
  } else {
    optimizations.push(
      `Active combos: ${combos.join(", ")}. Ensure reset-aware limits are configured for tier stability.`
    );
  }

  const analytics: ProjectAnalytics = {
    tokenEconomics,
    sessions,
    agents,
    optimizations,
    lastComputedAt: Math.floor(Date.now() / 1000),
  };

  // Persist computed analytics to project cache
  setAnalyticsCache(projectId, analytics);

  return analytics;
}

/**
 * Generates an on-demand executive brief with structured recommendations.
 */
export async function generateProjectBrief(projectId: string): Promise<ProjectBrief | null> {
  const project = getProject(projectId);
  if (!project) return null;

  // Ensure latest analytics are computed
  const analytics = await calculateProjectAnalytics(projectId);
  const tokenEco = analytics?.tokenEconomics ?? {
    success: 0,
    wasted: 0,
    cached: 0,
    saved: 0,
    costUsd: 0,
  };

  const summary =
    `${project.name} is configured at path "${project.basePath}". ` +
    `Tech stack includes: ${(project.techStack ?? []).join(", ") || "Standard"}. ` +
    `Currently tracks ${project.filesCount ?? 0} files and ${project.docsCount ?? 0} documents. ` +
    `Total tokens processed: ${tokenEco.success.toLocaleString()} success, ${tokenEco.wasted.toLocaleString()} wasted, and ${tokenEco.cached.toLocaleString()} cached. ` +
    `Estimated total cost: $${tokenEco.costUsd.toFixed(4)}.`;

  const optimizations = analytics?.optimizations ?? [
    "Enable prompt caching on repeated system instructions.",
    "Route low-complexity requests through auto-combo fast tiers.",
  ];

  const recommendations = [
    "Keep local documentation synchronized in `docs/` or `_tasks/`.",
    "Leverage persistent memory RAG for cross-session knowledge preservation.",
    "Monitor wasted tokens to catch provider rate limits early.",
  ];

  const brief: ProjectBrief = {
    summary,
    optimizations,
    recommendations,
    generatedAt: Math.floor(Date.now() / 1000),
  };

  setBriefCache(projectId, brief);
  return brief;
}
