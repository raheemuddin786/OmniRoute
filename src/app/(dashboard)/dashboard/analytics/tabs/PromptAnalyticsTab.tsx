"use client";

import React, { useState, useMemo } from "react";
import { PromptListItem, type PromptItemData } from "../components/PromptListItem";
import { SessionAccordion, type SessionGroupData } from "../components/SessionAccordion";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { generatePromptsCSV, generatePromptsJSON, downloadFile } from "@/shared/utils/promptExport";
import { fmtCompact } from "@/shared/utils/formatting";
import { normalizeForSearch } from "@/shared/utils/turkishText";

interface PromptAnalyticsTabProps {
  recentPrompts?: Array<{
    prompt: string;
    timestamp: string;
    model?: string;
    requestedModel?: string;
    tokensIn?: number;
    tokensOut?: number;
    tokensCacheRead?: number;
    tokensCacheCreation?: number;
    tokensReasoning?: number;
    costUsd?: number;
    durationMs?: number;
    status?: number;
    toolsUsed?: string[];
    filesModified?: string[];
    sessionTag?: string;
    responseSummary?: string;
    provider?: string;
    comboName?: string;
    errorType?: string | null;
    errorSummary?: string | null;
  }>;
  tokensInSuccess?: number;
  tokensOutSuccess?: number;
  _tokensInSuccess?: number;
  _tokensOutSuccess?: number;
  tokenEconomics?: {
    success?: number;
    wasted?: number;
    cached?: number;
    saved?: number;
    costUsd?: number;
  };
  sessionGroups?: SessionGroupData[];
  selectedProjectId?: string;
  onRefresh?: () => void;
  calculating?: boolean;
}

export function PromptAnalyticsTab({
  recentPrompts = [],
  _tokensInSuccess = 0,
  _tokensOutSuccess = 0,
  tokenEconomics = {},
  sessionGroups: initialSessionGroups = [],
  selectedProjectId,
  onRefresh,
  calculating = false,
}: PromptAnalyticsTabProps) {
  const [viewMode, setViewMode] = useState<"hierarchical" | "flat">("hierarchical");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [copiedAll, setCopiedAll] = useState<boolean>(false);

  // Map real telemetry records to PromptItemData (no estimation, no hardcoding)
  const promptList: PromptItemData[] = useMemo(() => {
    return recentPrompts.map((rp, idx) => {
      const inTokens = Number(rp.tokensIn ?? 0);
      const outTokens = Number(rp.tokensOut ?? 0);
      const cacheTokens = Number(rp.tokensCacheRead ?? 0);

      return {
        id: `prompt_${idx + 1}`,
        prompt: rp.prompt,
        timestamp: rp.timestamp,
        model: rp.model || "auto-combo",
        tokensIn: inTokens,
        tokensOut: outTokens,
        tokensCacheRead: cacheTokens,
        costUsd: Number(rp.costUsd ?? 0),
        durationMs: Number(rp.durationMs ?? 0),
        status: Number(rp.status ?? 200),
        toolsUsed: rp.toolsUsed && rp.toolsUsed.length > 0 ? rp.toolsUsed : undefined,
        filesModified:
          rp.filesModified && rp.filesModified.length > 0 ? rp.filesModified : undefined,
        sessionTag: rp.sessionTag,
        responseSummary: rp.responseSummary,
      };
    });
  }, [recentPrompts]);

  // Group prompts into sessions by real session_tag, falling back to sequential grouping
  const sessionGroups: SessionGroupData[] = useMemo(() => {
    if (initialSessionGroups && initialSessionGroups.length > 0) {
      return initialSessionGroups;
    }
    if (promptList.length === 0) return [];

    const groups: SessionGroupData[] = [];
    const sessionMap = new Map<string, PromptItemData[]>();
    const fallbackOrder: string[] = [];

    for (const p of promptList) {
      const key = p.sessionTag || `conv_session_${fallbackOrder.length + 1}`;
      if (!sessionMap.has(key)) {
        sessionMap.set(key, []);
        fallbackOrder.push(key);
      }
      sessionMap.get(key)!.push(p);
    }

    for (const key of fallbackOrder) {
      const chunk = sessionMap.get(key)!;
      const sessionCost = chunk.reduce((sum, p) => sum + (p.costUsd || 0), 0);
      const sessionTokens = chunk.reduce(
        (sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0),
        0
      );

      groups.push({
        sessionId: key,
        firstSeenAt: chunk[0].timestamp,
        lastSeenAt: chunk[chunk.length - 1].timestamp,
        turnCount: chunk.length,
        prompts: chunk,
        totalTokens: sessionTokens,
        totalCostUsd: sessionCost,
        modelUsed: chunk[0].model,
        toolsCount: chunk.filter((p) => p.toolsUsed && p.toolsUsed.length > 0).length,
      });
    }

    return groups;
  }, [promptList, initialSessionGroups]);

  // Filtered prompts and sessions based on search (using Turkish-safe search utility)
  const filteredPrompts = useMemo(() => {
    if (!searchQuery.trim()) return promptList;
    const q = searchQuery.toLowerCase().trim();
    return promptList.filter(
      (p) =>
        normalizeForSearch(p.prompt).includes(q) ||
        (p.model && normalizeForSearch(p.model).includes(q)) ||
        (p.toolsUsed && p.toolsUsed.some((t) => normalizeForSearch(t).includes(q)))
    );
  }, [promptList, searchQuery]);

  const filteredSessionGroups = useMemo(() => {
    if (!searchQuery.trim()) return sessionGroups;
    const q = searchQuery.toLowerCase().trim();
    return sessionGroups.filter(
      (s) =>
        normalizeForSearch(s.sessionId).includes(q) ||
        s.prompts.some((p) => normalizeForSearch(p.prompt).includes(q))
    );
  }, [sessionGroups, searchQuery]);

  // Copy all visible prompts
  const handleCopyAll = async () => {
    const allText = filteredPrompts
      .map(
        (p, idx) =>
          `=== Prompt #${idx + 1} [${p.timestamp}] (${p.model || "default"}) ===\n${p.prompt}`
      )
      .join("\n\n");
    const ok = await copyToClipboard(allText);
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    }
  };

  // Export full prompt history to CSV/JSON
  const handleExportAll = (format: "json" | "csv") => {
    const exportRecords = filteredPrompts.map((p) => ({
      prompt: p.prompt,
      timestamp: p.timestamp,
      project: selectedProjectId || "Global",
      model: p.model,
      costUsd: p.costUsd,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      toolsUsed: p.toolsUsed,
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const projSlug = selectedProjectId
      ? selectedProjectId.replace(/[^a-zA-Z0-9_-]/g, "_")
      : "global";

    if (format === "csv") {
      const csv = generatePromptsCSV(exportRecords);
      downloadFile(csv, `prompts-${projSlug}-${dateStr}.csv`, "text/csv");
    } else {
      const json = generatePromptsJSON(exportRecords, {
        projectName: selectedProjectId || "Global Application",
        totalSessions: sessionGroups.length,
      });
      downloadFile(json, `prompts-${projSlug}-${dateStr}.json`, "application/json");
    }
  };

  // Calculate metrics for display cards - prioritizing real project-level token economics when available
  const metrics = useMemo(() => {
    const totalPrompts = promptList.length;
    const uniquePrompts = promptList.filter(
      (p, idx, self) => idx === self.findIndex((t) => t.prompt === p.prompt)
    ).length;
    // Prefer overall economics aggregated from database, fallback strictly to sum of loaded prompts
    const totalCost =
      tokenEconomics && typeof tokenEconomics.costUsd === "number" && tokenEconomics.costUsd > 0
        ? tokenEconomics.costUsd
        : promptList.reduce((sum, p) => sum + (p.costUsd || 0), 0);
    const totalTokens =
      tokenEconomics && typeof tokenEconomics.success === "number" && tokenEconomics.success > 0
        ? tokenEconomics.success
        : promptList.reduce((sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0), 0);
    const cacheHits =
      tokenEconomics && typeof tokenEconomics.cached === "number" && tokenEconomics.cached > 0
        ? tokenEconomics.cached
        : promptList.reduce((sum, p) => sum + (p.tokensCacheRead || 0), 0);

    return {
      totalPrompts,
      uniquePrompts,
      totalCost,
      totalTokens,
      cacheHits,
      sessionCount: sessionGroups.length,
    };
  }, [promptList, sessionGroups, tokenEconomics]);

  return (
    <div className="space-y-6">
      {/* Key Metrics Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-purple-500/30">
          <span className="text-[11px] text-purple-400 font-medium uppercase tracking-wider block">
            Total Prompts
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.totalPrompts)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Indexed turns</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-indigo-500/30">
          <span className="text-[11px] text-indigo-400 font-medium uppercase tracking-wider block">
            Unique Prompts
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.uniquePrompts)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Distinct queries</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-emerald-500/30">
          <span className="text-[11px] text-emerald-400 font-medium uppercase tracking-wider block">
            Agent Sessions
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.sessionCount)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Multi-turn groups</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-amber-500/30">
          <span className="text-[11px] text-amber-400 font-medium uppercase tracking-wider block">
            Total Cost
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            ${metrics.totalCost.toFixed(4)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">LLM usage cost</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-blue-500/30">
          <span className="text-[11px] text-blue-400 font-medium uppercase tracking-wider block">
            Cache Hits
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.cacheHits)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Estimated token savings</span>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <span className="text-slate-500 text-xs">🔍</span>
          <input
            type="text"
            placeholder="Search prompts, models, or tool invocations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-slate-500 hover:text-slate-300 text-xs px-1"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Switcher */}
          <div className="flex items-center rounded-lg border border-slate-800 p-0.5 bg-slate-950 text-xs">
            <button
              type="button"
              onClick={() => setViewMode("hierarchical")}
              className={`px-3 py-1 rounded-md transition-colors ${
                viewMode === "hierarchical"
                  ? "bg-indigo-600 text-white font-medium shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              🗂️ Sessions Hierarchy
            </button>
            <button
              type="button"
              onClick={() => setViewMode("flat")}
              className={`px-3 py-1 rounded-md transition-colors ${
                viewMode === "flat"
                  ? "bg-indigo-600 text-white font-medium shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              📋 Flat Prompts
            </button>
          </div>

          {/* Refresh Analytics Button */}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={calculating}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5"
              title="Refresh Analytics data"
            >
              <span>{calculating ? "⏳" : "🔄"}</span>
              <span>{calculating ? "Refreshing..." : "Refresh"}</span>
            </button>
          )}

          {/* Copy All Button */}
          <button
            type="button"
            onClick={handleCopyAll}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors flex items-center gap-1.5"
            title="Copy all visible prompts"
          >
            <span>{copiedAll ? "✓" : "📋"}</span>
            <span>{copiedAll ? "Copied All" : "Copy All"}</span>
          </button>

          {/* Export Utilities */}
          <div className="flex items-center rounded-lg border border-slate-700 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => handleExportAll("json")}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border-r border-slate-700 transition-colors"
              title="Export all prompts to JSON"
            >
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => handleExportAll("csv")}
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
              title="Export all prompts to CSV"
            >
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* Prompts / Sessions Content List */}
      <div className="space-y-3">
        {viewMode === "hierarchical" ? (
          filteredSessionGroups.length === 0 ? (
            <div className="py-12 text-center bg-slate-950/40 rounded-xl border border-slate-800/60 p-6 space-y-3">
              <span className="text-2xl block">💬</span>
              <p className="text-slate-300 font-medium text-sm">
                No indexed prompt turns recorded yet for {selectedProjectId || "this workspace"}.
              </p>
              <p className="text-slate-500 text-xs max-w-md mx-auto">
                Prompts are automatically captured during agent operations or proxy requests routed
                through OmniRoute. Run commands or route completions to see execution histories
                here.
              </p>
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={calculating}
                  className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                >
                  {calculating ? "Refreshing..." : "Refresh Prompt Analytics"}
                </button>
              )}
            </div>
          ) : (
            filteredSessionGroups.map((session, sIdx) => (
              <SessionAccordion
                key={session.sessionId}
                session={session}
                index={sIdx}
                projectName={selectedProjectId || "Global Application"}
                defaultExpanded={sIdx === 0}
              />
            ))
          )
        ) : filteredPrompts.length === 0 ? (
          <div className="py-12 text-center bg-slate-950/40 rounded-xl border border-slate-800/60 p-6 space-y-3">
            <span className="text-2xl block">📋</span>
            <p className="text-slate-300 font-medium text-sm">No matching prompts found.</p>
            <p className="text-slate-500 text-xs">
              Try adjusting your search criteria or refresh on-demand analytics.
            </p>
          </div>
        ) : (
          filteredPrompts.map((promptItem, pIdx) => (
            <PromptListItem
              key={pIdx}
              item={promptItem}
              index={pIdx}
              defaultExpanded={pIdx === 0}
            />
          ))
        )}
      </div>
    </div>
  );
}
