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
    systemPrompt?: string;
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

      const safePromptText = typeof rp.prompt === "string" ? rp.prompt : "";
      const safeSystemPromptText =
        typeof rp.systemPrompt === "string" && rp.systemPrompt ? rp.systemPrompt : undefined;
      const safeTimestamp = typeof rp.timestamp === "string" ? rp.timestamp : "";

      return {
        id: `prompt_${idx + 1}`,
        prompt: safePromptText,
        systemPrompt: safeSystemPromptText,
        timestamp: safeTimestamp,
        model: rp.model || rp.requestedModel || undefined,
        tokensIn: inTokens,
        tokensOut: outTokens,
        tokensCacheRead: cacheTokens,
        costUsd: Number(rp.costUsd ?? 0),
        durationMs: Number(rp.durationMs ?? 0),
        status: rp.status !== undefined && rp.status !== null ? Number(rp.status) : undefined,
        toolsUsed: rp.toolsUsed && rp.toolsUsed.length > 0 ? rp.toolsUsed : undefined,
        filesModified:
          rp.filesModified && rp.filesModified.length > 0 ? rp.filesModified : undefined,
        sessionTag: rp.sessionTag,
        responseSummary: rp.responseSummary,
      };
    });
  }, [recentPrompts]);

  // Group prompts into sessions by real session_tag, ensuring chronological conversation order per session
  const sessionGroups: SessionGroupData[] = useMemo(() => {
    if (initialSessionGroups && initialSessionGroups.length > 0) {
      return initialSessionGroups;
    }
    if (promptList.length === 0) return [];

    const groups: SessionGroupData[] = [];
    const sessionMap = new Map<string, PromptItemData[]>();
    const sessionOrder: string[] = [];

    for (const p of promptList) {
      const key = p.sessionTag || `conv_session_${sessionOrder.length + 1}`;
      if (!sessionMap.has(key)) {
        sessionMap.set(key, []);
        sessionOrder.push(key);
      }
      sessionMap.get(key)!.push(p);
    }

    for (const key of sessionOrder) {
      const rawPrompts = sessionMap.get(key)!;
      // Sort turns chronologically ascending (Turn #1 = earliest, Turn #N = newest) for intuitive conversation flow
      const sortedPrompts = [...rawPrompts].sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeA - timeB;
      });

      const sessionCost = sortedPrompts.reduce((sum, p) => sum + (p.costUsd || 0), 0);
      const sessionTokens = sortedPrompts.reduce(
        (sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0),
        0
      );

      groups.push({
        sessionId: key,
        firstSeenAt: sortedPrompts[0]?.timestamp || "",
        lastSeenAt: sortedPrompts[sortedPrompts.length - 1]?.timestamp || "",
        turnCount: sortedPrompts.length,
        prompts: sortedPrompts,
        totalTokens: sessionTokens,
        totalCostUsd: sessionCost,
        modelUsed: sortedPrompts[0]?.model,
        toolsCount: sortedPrompts.filter((p) => p.toolsUsed && p.toolsUsed.length > 0).length,
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
        normalizeForSearch(p.prompt || "").includes(q) ||
        (p.systemPrompt && normalizeForSearch(p.systemPrompt).includes(q)) ||
        (p.model && normalizeForSearch(p.model).includes(q)) ||
        (p.toolsUsed && p.toolsUsed.some((t) => normalizeForSearch(t).includes(q)))
    );
  }, [promptList, searchQuery]);

  const filteredSessionGroups = useMemo(() => {
    if (!searchQuery.trim()) return sessionGroups;
    const q = searchQuery.toLowerCase().trim();
    return sessionGroups.filter(
      (s) =>
        normalizeForSearch(s.sessionId || "").includes(q) ||
        s.prompts.some(
          (p) =>
            normalizeForSearch(p.prompt || "").includes(q) ||
            (p.systemPrompt && normalizeForSearch(p.systemPrompt).includes(q)) ||
            (p.model && normalizeForSearch(p.model).includes(q))
        )
    );
  }, [sessionGroups, searchQuery]);

  const handleCopyAll = async () => {
    const text = promptList
      .map((p, idx) => {
        const sys = typeof p.systemPrompt === "string" ? p.systemPrompt : "";
        const usr = typeof p.prompt === "string" ? p.prompt : "";
        const ts = typeof p.timestamp === "string" ? p.timestamp : "";
        const sysHeader = sys ? `\n[System Directives]\n${sys}\n` : "";
        return `--- Prompt #${idx + 1} (${ts}) ---${sysHeader}\n[User Turn]\n${usr}`;
      })
      .join("\n\n");
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    }
  };

  const handleExportAll = (format: "json" | "csv") => {
    const exportRecords = promptList.map((p) => ({
      prompt: typeof p.prompt === "string" ? p.prompt : "",
      systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt : undefined,
      timestamp: typeof p.timestamp === "string" ? p.timestamp : "",
      project: selectedProjectId || "Active Workspace",
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

  // Calculate metrics for display cards
  const metrics = useMemo(() => {
    const totalPrompts = promptList.length;
    const uniquePrompts = promptList.filter(
      (p, idx, self) => idx === self.findIndex((t) => t.prompt === p.prompt)
    ).length;
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
            User Prompts
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.totalPrompts)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Sequential turns</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-indigo-500/30">
          <span className="text-[11px] text-indigo-400 font-medium uppercase tracking-wider block">
            Unique Queries
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.uniquePrompts)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Distinct user inputs</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-emerald-500/30">
          <span className="text-[11px] text-emerald-400 font-medium uppercase tracking-wider block">
            Chat Sessions
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.sessionCount)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Conversations</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-amber-500/30">
          <span className="text-[11px] text-amber-400 font-medium uppercase tracking-wider block">
            Total Cost
          </span>
          <div className="text-xl font-bold text-amber-400 mt-1 font-mono">
            ${metrics.totalCost.toFixed(4)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">Ledger cost</span>
        </div>

        <div className="bg-slate-950/60 p-3.5 rounded-xl border border-sky-500/30 col-span-2 sm:col-span-1">
          <span className="text-[11px] text-sky-400 font-medium uppercase tracking-wider block">
            Total Tokens
          </span>
          <div className="text-xl font-bold text-slate-100 mt-1 font-mono">
            {fmtCompact(metrics.totalTokens)}
          </div>
          <span className="text-[10px] text-slate-500 block mt-0.5">
            {metrics.cacheHits > 0 ? `${fmtCompact(metrics.cacheHits)} cached` : "Telemetry"}
          </span>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/50 p-3.5 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <span className="text-slate-500 text-xs">🔍</span>
          <input
            type="text"
            placeholder="Search user prompts, models, or tool invocations..."
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
              💬 Conversation Sessions
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
              📋 All Prompts List
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
              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors border-r border-slate-700"
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
            <div className="space-y-3">
              {filteredSessionGroups.map((session, sIdx) => (
                <SessionAccordion
                  key={session.sessionId || sIdx}
                  session={session}
                  index={sIdx}
                  projectName={selectedProjectId || "Active Workspace"}
                  defaultExpanded={sIdx === 0}
                />
              ))}
            </div>
          )
        ) : filteredPrompts.length === 0 ? (
          <div className="py-12 text-center bg-slate-950/40 rounded-xl border border-slate-800/60 p-6">
            <span className="text-2xl block mb-2">🔍</span>
            <p className="text-slate-300 font-medium text-sm">
              No prompts match query &quot;{searchQuery}&quot;.
            </p>
            <p className="text-slate-500 text-xs mt-1">Try searching with a different term.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredPrompts.map((item, idx) => (
              <PromptListItem key={item.id || idx} item={item} index={idx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
