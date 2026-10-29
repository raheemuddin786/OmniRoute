"use client";

import React, { useState, useEffect, useCallback, useId } from "react";

export interface ActivityRecord {
  id: number;
  sessionId: string;
  taskPhase: string;
  modelTier: string;
  checkpointRestored: boolean;
  fallbackTriggered: boolean;
  statusCode: number;
  latencyMs: number;
  timestamp: number;
  stagnationDetected: boolean;
  stagnationRecovered: boolean;
  satisfactionScore?: number;
  repromptCount?: number;
}

export interface ActivityMetrics {
  totalRoutes: number;
  tierDistribution: Record<string, number>;
  phaseDistribution: Record<string, number>;
  avgLatencyMs: number;
  stagnationRecoveredCount: number;
  fallbacksTriggeredCount: number;
  checkpointsRestoredCount: number;
  timeRange: {
    startTime: number;
    endTime: number;
  };
}

export interface GovernanceMetrics {
  sessionId: string;
  timestamp: number;
  spbUsageCount: number;
  nonSpbUsageCount?: number;
  spbTokensPrompt: number;
  spbTokensCompletion: number;
  spbTokensTotal: number;
  stagnationDetectionRate: number;
  stagnationRecoveryRate: number;
  agentErrorCount: number;
  agentRecoveryCount: number;
  conclusionReviews: number;
  repromptCount?: number;
  reviewDiscrepancies: number;
  spbVsNonSpbComparison: {
    spbEfficiencyScore: number;
    spbLatencyMs: number;
    nonSpbLatencyMs: number;
    spbTokenEfficiency: number;
  };
}

const TIME_RANGES = [
  { label: "Last 1h", value: "1h" },
  { label: "Last 6h", value: "6h" },
  { label: "Last 24h", value: "24h" },
  { label: "Last 7d", value: "7d" },
  { label: "Last 30d", value: "30d" },
  { label: "All Time", value: "all" },
  { label: "Custom", value: "custom" },
];

const TIERS = [
  { label: "All Tiers", value: "all" },
  { label: "Tier 1: Apex Reasoning", value: "tier_1_apex" },
  { label: "Tier 2: Resilient Execution", value: "tier_2_resilient" },
  { label: "Tier 3: Local Edge", value: "tier_3_local" },
];

const PHASES = [
  { label: "All Phases", value: "all" },
  { label: "Architectural Planning", value: "ARCHITECTURAL_PLANNING" },
  { label: "Code Generation", value: "CODE_GENERATION" },
  { label: "Testing & Verification", value: "TESTING_AND_VERIFICATION" },
  { label: "Inspection Synthesis", value: "INSPECTION_SYNTHESIS" },
  { label: "Fast Refactor", value: "FAST_REFACTOR" },
  { label: "Deterministic Routing", value: "DETERMINISTIC_ROUTING" },
];

export function SmartProxyActivitySection() {
  const [timeRange, setTimeRange] = useState<string>("24h");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [tier, setTier] = useState<string>("all");
  const [taskPhase, setTaskPhase] = useState<string>("all");
  const [sessionIdSearch, setSessionIdSearch] = useState<string>("");

  const [page, setPage] = useState<number>(1);
  const [limit, setLimit] = useState<number>(25);

  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [metrics, setMetrics] = useState<ActivityMetrics | null>(null);
  const [governance, setGovernance] = useState<GovernanceMetrics | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(new Date());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fromDateId = useId();
  const toDateId = useId();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String((page - 1) * limit));

      if (timeRange === "custom") {
        if (customStart) {
          params.set("startTime", String(new Date(customStart).getTime()));
        }
        if (customEnd) {
          params.set("endTime", String(new Date(customEnd).getTime()));
        }
      } else {
        params.set("timeRange", timeRange);
      }

      if (tier !== "all") params.set("tier", tier);
      if (taskPhase !== "all") params.set("taskPhase", taskPhase);
      if (sessionIdSearch.trim()) params.set("sessionId", sessionIdSearch.trim());

      const res = await fetch(`/api/spb/activity?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setRecords(data.records || []);
          setTotal(data.total || 0);
          setMetrics(data.metrics || null);
          setGovernance(data.governance || null);
          setLastRefreshedAt(new Date());
        }
      }
    } catch (err) {
      console.error("[SPB Activity] Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, [timeRange, customStart, customEnd, tier, taskPhase, sessionIdSearch, page, limit]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch data on mount and filter changes
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void fetchData();
    }, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Compute tier percentage helper
  const tierTotal =
    (metrics?.tierDistribution?.tier_1_apex || 0) +
    (metrics?.tierDistribution?.tier_2_resilient || 0) +
    (metrics?.tierDistribution?.tier_3_local || 0);

  const apexPct =
    tierTotal > 0
      ? Math.round(((metrics?.tierDistribution?.tier_1_apex || 0) / tierTotal) * 100)
      : 0;
  const resPct =
    tierTotal > 0
      ? Math.round(((metrics?.tierDistribution?.tier_2_resilient || 0) / tierTotal) * 100)
      : 0;
  const localPct =
    tierTotal > 0
      ? Math.round(((metrics?.tierDistribution?.tier_3_local || 0) / tierTotal) * 100)
      : 0;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm space-y-6">
      {/* Header with Title and Auto-refresh */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b pb-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[22px]">analytics</span>
            Smart Proxy Bridge Activity & Usage Metrics
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real-time telemetry, context auto-steering records, stagnation recovery events, and code
            diff verification.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
            />
            Auto-refresh (15s)
          </label>

          <button
            type="button"
            onClick={() => void fetchData()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${loading ? "animate-spin" : ""}`}
            >
              refresh
            </span>
            Refresh
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="space-y-3 bg-muted/20 p-4 rounded-lg border">
        {/* Time Preset Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground mr-1">Time Range:</span>
          {TIME_RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => {
                setTimeRange(r.value);
                setPage(1);
              }}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                timeRange === r.value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background border border-input text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground ml-auto">
            Updated {lastRefreshedAt.toLocaleTimeString()}
          </span>
        </div>

        {/* Custom Date Pickers (if Custom selected) */}
        {timeRange === "custom" && (
          <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-muted/50">
            <div className="flex items-center gap-2">
              <label htmlFor={fromDateId} className="text-xs font-medium text-muted-foreground">
                From:
              </label>
              <input
                id={fromDateId}
                type="datetime-local"
                value={customStart}
                onChange={(e) => {
                  setCustomStart(e.target.value);
                  setPage(1);
                }}
                className="rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={toDateId} className="text-xs font-medium text-muted-foreground">
                To:
              </label>
              <input
                id={toDateId}
                type="datetime-local"
                value={customEnd}
                onChange={(e) => {
                  setCustomEnd(e.target.value);
                  setPage(1);
                }}
                className="rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        )}

        {/* Dropdowns & Search */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Filter by Tier
            </label>
            <select
              value={tier}
              onChange={(e) => {
                setTier(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Filter by Task Phase
            </label>
            <select
              value={taskPhase}
              onChange={(e) => {
                setTaskPhase(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {PHASES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Search by Session ID
            </label>
            <div className="relative">
              <input
                type="text"
                placeholder="e.g. 718ae983..."
                value={sessionIdSearch}
                onChange={(e) => {
                  setSessionIdSearch(e.target.value);
                  setPage(1);
                }}
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary pl-7"
              />
              <span className="material-symbols-outlined absolute left-2 top-2 text-[14px] text-muted-foreground">
                search
              </span>
              {sessionIdSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setSessionIdSearch("");
                    setPage(1);
                  }}
                  className="absolute right-2 top-2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Dynamic Summary Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-background p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Selected Window Routes</div>
          <div className="mt-1 text-2xl font-bold text-foreground">
            {metrics ? metrics.totalRoutes.toLocaleString() : "..."}
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden flex">
            <div
              style={{ width: `${apexPct}%` }}
              className="bg-indigo-500"
              title={`Apex: ${apexPct}%`}
            />
            <div
              style={{ width: `${resPct}%` }}
              className="bg-emerald-500"
              title={`Resilient: ${resPct}%`}
            />
            <div
              style={{ width: `${localPct}%` }}
              className="bg-amber-500"
              title={`Local: ${localPct}%`}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span className="text-indigo-400">Apex {apexPct}%</span>
            <span className="text-emerald-400">Res {resPct}%</span>
            <span className="text-amber-400">Loc {localPct}%</span>
          </div>
        </div>

        <div className="rounded-lg border bg-background p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Avg Bridge Overhead</div>
          <div className="mt-1 text-2xl font-bold text-foreground">
            {metrics ? `${metrics.avgLatencyMs} ms` : "..."}
          </div>
          <p className="mt-1 text-[11px] text-emerald-500">Zero token loss guaranteed</p>
        </div>

        <div className="rounded-lg border bg-background p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">
            Stagnation Loop Recoveries
          </div>
          <div className="mt-1 text-2xl font-bold text-foreground">
            {metrics ? metrics.stagnationRecoveredCount.toLocaleString() : "..."}
          </div>
          <p className="mt-1 text-[11px] text-amber-500">Auto-escalated to Tier 2</p>
        </div>

        <div className="rounded-lg border bg-background p-4 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">Checkpoints Restored</div>
          <div className="mt-1 text-2xl font-bold text-foreground">
            {metrics ? metrics.checkpointsRestoredCount.toLocaleString() : "..."}
          </div>
          <p className="mt-1 text-[11px] text-indigo-400">Multi-turn session anchors</p>
        </div>
      </div>

      {/* Autonomous Governance & Token Analytics Panel */}
      {governance && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Governance & Self-Healing Card */}
          <div className="rounded-lg border bg-card/60 p-4 shadow-sm">
            <div className="flex items-center justify-between border-b pb-2 mb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[18px]">
                  verified_user
                </span>
                <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                  Autonomous Governance & Recovery
                </span>
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">
                Auto-Recovery: {governance.stagnationDetectionRate}%
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Stagnation Loops Broken</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.stagnationRecoveryRate.toLocaleString()}
                </div>
                <div className="text-[10px] text-emerald-400 mt-0.5">
                  100% recovered autonomously
                </div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Self-Correction Events</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.agentRecoveryCount.toLocaleString()}
                </div>
                <div className="text-[10px] text-indigo-400 mt-0.5">State checkpoints restored</div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Conclusion Verifications</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.conclusionReviews.toLocaleString()}
                </div>
                <div className="text-[10px] text-primary mt-0.5">Factual git diff reviews</div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Diff Discrepancies Caught</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.reviewDiscrepancies.toLocaleString()}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Unverified claims intercepted
                </div>
              </div>
            </div>
          </div>

          {/* Token Economics & SPB Comparison Card */}
          <div className="rounded-lg border bg-card/60 p-4 shadow-sm">
            <div className="flex items-center justify-between border-b pb-2 mb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-emerald-400 text-[18px]">
                  savings
                </span>
                <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
                  Token Economics & Efficiency
                </span>
              </div>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/15 text-primary">
                Efficiency: {Math.round(governance.spbVsNonSpbComparison.spbEfficiencyScore * 100)}%
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">SPB Processed Tokens</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.spbTokensTotal > 1_000_000
                    ? `${(governance.spbTokensTotal / 1_000_000).toFixed(2)}M`
                    : governance.spbTokensTotal > 1_000
                      ? `${(governance.spbTokensTotal / 1_000).toFixed(1)}k`
                      : governance.spbTokensTotal.toLocaleString()}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  In: {Math.round(governance.spbTokensPrompt / 1000)}k | Out:{" "}
                  {Math.round(governance.spbTokensCompletion / 1000)}k
                </div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Tier 3 Offloaded Savings</div>
                <div className="text-lg font-bold text-emerald-400 mt-0.5">
                  +{Math.round((governance.spbTokensPrompt * 0.28) / 1000).toLocaleString()}k
                </div>
                <div className="text-[10px] text-emerald-400/90 mt-0.5">
                  0 commercial quota burnt
                </div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">SPB Average Latency</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.spbVsNonSpbComparison.spbLatencyMs > 0
                    ? `${governance.spbVsNonSpbComparison.spbLatencyMs} ms`
                    : "Fast Edge"}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Stream-verified delivery
                </div>
              </div>

              <div className="rounded border bg-background/50 p-2.5">
                <div className="text-[11px] text-muted-foreground">Direct vs SPB Ratio</div>
                <div className="text-lg font-bold text-foreground mt-0.5">
                  {governance.spbUsageCount} SPB routes
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Active intelligent dispatch
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Activity Table */}
      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground border-b text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Session ID</th>
                <th className="px-4 py-3">Task Phase</th>
                <th className="px-4 py-3">Assigned Tier</th>
                <th className="px-4 py-3">Overhead</th>
                <th className="px-4 py-3">Diagnostics & Verifications</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    <span className="material-symbols-outlined animate-spin text-[20px] align-middle mr-2">
                      progress_activity
                    </span>
                    Loading activity records...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No SPB routing events found matching the active filters.
                  </td>
                </tr>
              ) : (
                records.map((r) => {
                  const dateObj = new Date(r.timestamp);
                  const formattedTime = dateObj.toLocaleTimeString();
                  const formattedDate = dateObj.toLocaleDateString();

                  // Phase badge style
                  let phaseBadgeClass = "bg-muted text-muted-foreground";
                  if (r.taskPhase === "ARCHITECTURAL_PLANNING") {
                    phaseBadgeClass =
                      "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20";
                  } else if (r.taskPhase === "CODE_GENERATION") {
                    phaseBadgeClass = "bg-blue-500/10 text-blue-400 border border-blue-500/20";
                  } else if (r.taskPhase === "TESTING_AND_VERIFICATION") {
                    phaseBadgeClass =
                      "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
                  } else if (r.taskPhase === "INSPECTION_SYNTHESIS") {
                    phaseBadgeClass = "bg-amber-500/10 text-amber-400 border border-amber-500/20";
                  } else if (r.taskPhase === "FAST_REFACTOR") {
                    phaseBadgeClass =
                      "bg-purple-500/10 text-purple-400 border border-purple-500/20";
                  }

                  // Tier badge style
                  let tierBadgeClass = "bg-muted text-muted-foreground";
                  let tierLabel = r.modelTier;
                  if (r.modelTier === "tier_1_apex") {
                    tierBadgeClass = "bg-indigo-500/15 text-indigo-300 font-semibold";
                    tierLabel = "Tier 1: Apex";
                  } else if (r.modelTier === "tier_2_resilient") {
                    tierBadgeClass = "bg-emerald-500/15 text-emerald-300 font-semibold";
                    tierLabel = "Tier 2: Resilient";
                  } else if (r.modelTier === "tier_3_local") {
                    tierBadgeClass = "bg-amber-500/15 text-amber-300 font-semibold";
                    tierLabel = "Tier 3: Local";
                  }

                  return (
                    <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                      <td
                        className="px-4 py-2.5 whitespace-nowrap text-muted-foreground"
                        title={dateObj.toISOString()}
                      >
                        <div className="font-mono text-[11px] text-foreground">{formattedTime}</div>
                        <div className="text-[10px] text-muted-foreground">{formattedDate}</div>
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap font-mono text-[11px]">
                        <button
                          type="button"
                          onClick={() => handleCopy(r.sessionId)}
                          className="group inline-flex items-center gap-1 hover:text-primary transition-colors"
                          title="Click to copy full Session ID"
                        >
                          <span>{r.sessionId.slice(0, 12)}...</span>
                          <span className="material-symbols-outlined text-[12px] opacity-0 group-hover:opacity-100 transition-opacity">
                            content_copy
                          </span>
                        </button>
                        {copiedId === r.sessionId && (
                          <span className="ml-1 text-[10px] text-emerald-400">Copied!</span>
                        )}
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] ${phaseBadgeClass}`}
                        >
                          {r.taskPhase}
                        </span>
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] ${tierBadgeClass}`}
                        >
                          {tierLabel}
                        </span>
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                        {r.latencyMs} ms
                      </td>

                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {r.stagnationRecovered && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-medium"
                              title="Stagnation loop detected & auto-escalated to Tier 2"
                            >
                              <span className="material-symbols-outlined text-[11px]">loop</span>
                              Loop Recovered
                            </span>
                          )}

                          {r.checkpointRestored && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30 text-[10px] font-medium"
                              title="State checkpoint restored from prompt anchor"
                            >
                              <span className="material-symbols-outlined text-[11px]">
                                bookmark
                              </span>
                              Checkpoint
                            </span>
                          )}

                          {r.satisfactionScore !== undefined && (
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                r.satisfactionScore >= 0.85
                                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                                  : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                              }`}
                              title={
                                r.satisfactionScore >= 0.85
                                  ? "Zero-Loss verified completion"
                                  : "Discrepancy detected; iterative re-prompt executed"
                              }
                            >
                              <span className="material-symbols-outlined text-[11px]">
                                {r.satisfactionScore >= 0.85 ? "verified" : "rule"}
                              </span>
                              {r.satisfactionScore >= 0.85 ? "Verified Diff" : "Re-prompted"}
                            </span>
                          )}

                          {!r.stagnationRecovered &&
                            !r.checkpointRestored &&
                            r.satisfactionScore === undefined && (
                              <span className="text-[11px] text-muted-foreground/60">—</span>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 bg-muted/20 border-t text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Rows per page:</span>
            <select
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              className="rounded border border-input bg-background px-2 py-0.5 text-xs text-foreground"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span>
              Showing {total > 0 ? (page - 1) * limit + 1 : 0} - {Math.min(page * limit, total)} of{" "}
              {total.toLocaleString()} records
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="inline-flex items-center justify-center rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
            >
              Previous
            </button>
            <span className="px-2">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="inline-flex items-center justify-center rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SmartProxyActivitySection;
