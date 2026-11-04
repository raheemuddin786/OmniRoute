"use client";

import React, { useState } from "react";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { fmtCompact } from "@/shared/utils/formatting";

export interface PromptItemData {
  id?: string;
  prompt: string;
  systemPrompt?: string;
  timestamp: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  costUsd?: number;
  durationMs?: number;
  toolsUsed?: string[];
  filesModified?: string[];
  sessionTag?: string;
  responseSummary?: string;
  status?: number;
}

interface PromptListItemProps {
  item: PromptItemData;
  index: number;
  defaultExpanded?: boolean;
}

export function PromptListItem({ item, index, defaultExpanded = false }: PromptListItemProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(false);
  const [activeTechnicalTab, setActiveTechnicalTab] = useState<"system" | "summary" | "tools">(
    "system"
  );
  const [copiedUser, setCopiedUser] = useState<boolean>(false);
  const [copiedSystem, setCopiedSystem] = useState<boolean>(false);
  const [copiedFull, setCopiedFull] = useState<boolean>(false);

  // Defensive guards for prompt properties
  const safePrompt = typeof item?.prompt === "string" ? item.prompt : "";
  const safeSystemPrompt = typeof item?.systemPrompt === "string" ? item.systemPrompt : undefined;
  const safeResponseSummary =
    typeof item?.responseSummary === "string" && item.responseSummary.trim().length > 0
      ? item.responseSummary
      : undefined;
  const safeTimestamp = typeof item?.timestamp === "string" && item.timestamp ? item.timestamp : "";

  // Extract clean one-liner preview
  const cleanFirstLine =
    safePrompt
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "Empty prompt";

  const oneLinerPreview =
    cleanFirstLine.length > 120 ? `${cleanFirstLine.slice(0, 120)}...` : cleanFirstLine;

  const handleCopyUserPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(safePrompt);
    if (success) {
      setCopiedUser(true);
      setTimeout(() => setCopiedUser(false), 2000);
    }
  };

  const handleCopySystemPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!safeSystemPrompt) return;
    const success = await copyToClipboard(safeSystemPrompt);
    if (success) {
      setCopiedSystem(true);
      setTimeout(() => setCopiedSystem(false), 2000);
    }
  };

  const handleCopyFullRecord = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const fullText = [
      `=== Turn #${index + 1} (${safeTimestamp || "Recent"}) ===`,
      safeSystemPrompt ? `[System Directives]\n${safeSystemPrompt}\n` : null,
      `[User Prompt]\n${safePrompt}`,
      safeResponseSummary ? `\n[Agent Response]\n${safeResponseSummary}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const success = await copyToClipboard(fullText);
    if (success) {
      setCopiedFull(true);
      setTimeout(() => setCopiedFull(false), 2000);
    }
  };

  const formattedDate = safeTimestamp
    ? (() => {
        try {
          const d = new Date(safeTimestamp);
          return isNaN(d.getTime())
            ? safeTimestamp
            : d.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
        } catch {
          return safeTimestamp;
        }
      })()
    : "Recent";

  return (
    <div
      className={`border rounded-xl transition-all overflow-hidden ${
        expanded
          ? "bg-slate-900/95 border-indigo-500/50 shadow-md ring-1 ring-indigo-500/20"
          : "bg-slate-950/40 border-slate-800/70 hover:border-slate-700 hover:bg-slate-900/30"
      }`}
    >
      {/* Clickable Header: Clean User Turn Focus */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="p-3.5 flex items-start justify-between cursor-pointer gap-3 select-none"
      >
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {/* Turn Sequence Badge */}
          <span className="font-mono text-[11px] font-semibold text-indigo-300 bg-indigo-500/15 px-2 py-0.5 rounded-md border border-indigo-500/30 shrink-0 mt-0.5">
            Turn #{index + 1}
          </span>

          <div className="min-w-0 flex-1">
            {/* Metadata Line */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-[11px] text-slate-400 font-mono flex items-center gap-1">
                <span>🕒</span>
                {formattedDate}
              </span>

              {item.model && (
                <span className="text-[10px] font-mono bg-slate-800/90 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                  {item.model}
                </span>
              )}

              {item.status !== undefined && (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    item.status >= 200 && item.status < 300
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  {item.status}
                </span>
              )}

              {safeSystemPrompt && (
                <span
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-purple-500/15 text-purple-300 border-purple-500/30 flex items-center gap-1"
                  title="System instructions present"
                >
                  <span>🛡️</span>
                  System Directives
                </span>
              )}

              {item.toolsUsed && item.toolsUsed.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-300 border-amber-500/20">
                  🛠️ {item.toolsUsed.length} tool{item.toolsUsed.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {/* Clean User Prompt Preview */}
            <p className="text-xs text-slate-100 font-medium truncate leading-relaxed">
              {oneLinerPreview}
            </p>
          </div>
        </div>

        {/* Quick Stats & Expand Controls */}
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          {item.tokensIn !== undefined && (
            <span
              className="text-[11px] font-mono text-slate-400 hidden sm:inline-block"
              title="Input tokens"
            >
              {fmtCompact(item.tokensIn)} tokens
            </span>
          )}

          {item.costUsd !== undefined && item.costUsd > 0 && (
            <span className="text-[11px] font-mono text-amber-400 hidden md:inline-block">
              ${item.costUsd.toFixed(4)}
            </span>
          )}

          <button
            type="button"
            onClick={handleCopyUserPrompt}
            className={`px-2 py-1 rounded text-xs transition-colors border ${
              copiedUser
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
            }`}
            title="Copy user prompt"
          >
            {copiedUser ? "✓ Copied" : "📋 Copy"}
          </button>

          <span
            className={`text-slate-400 text-xs transition-transform duration-200 ml-1 ${
              expanded ? "rotate-90 text-indigo-400" : ""
            }`}
          >
            ▶
          </span>
        </div>
      </div>

      {/* Expanded Container: Full Clean User Prompt First */}
      {expanded && (
        <div className="p-4 pt-2 border-t border-slate-800/80 space-y-3.5 text-xs bg-slate-950/30">
          {/* Main User Prompt Section */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs pb-1">
              <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <span>💬</span>
                User Prompt ({safePrompt.length} characters)
              </span>
              <button
                type="button"
                onClick={handleCopyUserPrompt}
                className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium"
              >
                {copiedUser ? "✓ Copied Prompt" : "Copy Prompt"}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto p-3.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-200 whitespace-pre-wrap select-text leading-relaxed shadow-inner">
              {safePrompt}
            </div>
          </div>

          {/* Simple Default vs Technical Details Toggle */}
          <div className="border border-slate-800/80 rounded-lg p-2.5 bg-slate-900/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-slate-400 text-xs">⚙️</span>
                <span className="text-xs text-slate-300 font-medium">
                  Technical Execution & Model Details
                </span>
                {safeSystemPrompt && (
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-purple-950 text-purple-300 border border-purple-800">
                    Directives
                  </span>
                )}
                {safeResponseSummary && (
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Response
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyFullRecord}
                  className="px-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
                  title="Copy complete session turn with system context"
                >
                  {copiedFull ? "✓ Full Turn Copied" : "📋 Copy Full Turn"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTechnicalDetails(!showTechnicalDetails);
                  }}
                  className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 transition-colors flex items-center gap-1"
                >
                  <span>{showTechnicalDetails ? "Hide Details" : "Show Details"}</span>
                  <span
                    className={`transition-transform duration-200 ${
                      showTechnicalDetails ? "rotate-180" : ""
                    }`}
                  >
                    ▾
                  </span>
                </button>
              </div>
            </div>

            {/* Collapsible Technical Details (System Directives, AI Response, Tool Invocations, Token Metrics) */}
            {showTechnicalDetails && (
              <div className="mt-3 pt-3 border-t border-slate-800 space-y-3">
                {/* Navigation Tabs for Technical Subviews */}
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                    {safeSystemPrompt && (
                      <button
                        type="button"
                        onClick={() => setActiveTechnicalTab("system")}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          activeTechnicalTab === "system"
                            ? "bg-purple-600 text-white shadow-sm"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        🛡️ System Directives
                      </button>
                    )}
                    {safeResponseSummary && (
                      <button
                        type="button"
                        onClick={() => setActiveTechnicalTab("summary")}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                          activeTechnicalTab === "summary"
                            ? "bg-indigo-600 text-white shadow-sm"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        🤖 AI Output Summary
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveTechnicalTab("tools")}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                        activeTechnicalTab === "tools"
                          ? "bg-slate-700 text-white shadow-sm"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      🛠️ Tools & Metadata
                    </button>
                  </div>

                  {activeTechnicalTab === "system" && safeSystemPrompt && (
                    <button
                      type="button"
                      onClick={handleCopySystemPrompt}
                      className="px-2 py-0.5 text-[11px] rounded bg-purple-950/60 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30 transition-colors"
                    >
                      {copiedSystem ? "✓ Copied Directives" : "📋 Copy Directives"}
                    </button>
                  )}
                </div>

                {/* Subview 1: System Directives */}
                {activeTechnicalTab === "system" && safeSystemPrompt && (
                  <div>
                    <div className="text-[10px] text-purple-400 mb-1 font-mono uppercase tracking-wider flex items-center justify-between">
                      <span>System / Developer Directives</span>
                      <span className="text-purple-400/80 font-normal">Context Injected</span>
                    </div>
                    <div className="max-h-60 overflow-y-auto p-3 rounded-lg bg-purple-950/20 border border-purple-500/30 font-mono text-xs text-purple-100 whitespace-pre-wrap select-text leading-relaxed">
                      {safeSystemPrompt}
                    </div>
                  </div>
                )}

                {/* Subview 2: Agent Response Summary */}
                {activeTechnicalTab === "summary" && safeResponseSummary && (
                  <div>
                    <div className="text-[10px] text-indigo-400 mb-1 font-mono uppercase tracking-wider">
                      Agent Response Summary
                    </div>
                    <div className="max-h-60 overflow-y-auto p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 whitespace-pre-wrap select-text leading-relaxed">
                      {safeResponseSummary}
                    </div>
                  </div>
                )}

                {/* Subview 3: Tools & Metrics */}
                {activeTechnicalTab === "tools" && (
                  <div className="space-y-3">
                    {/* Tool Invocations */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400 font-medium">Tools Invocations:</span>
                      {item.toolsUsed && item.toolsUsed.length > 0 ? (
                        item.toolsUsed.map((tool, idx) => (
                          <span
                            key={idx}
                            className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono text-[11px]"
                          >
                            🛠️ {tool}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-500 font-mono">None invoked</span>
                      )}
                    </div>

                    {/* Files Modified */}
                    {item.filesModified && item.filesModified.length > 0 && (
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className="text-slate-400 font-medium">Files Touched:</span>
                        <div className="flex flex-wrap gap-1">
                          {item.filesModified.map((file, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded bg-indigo-950/50 border border-indigo-800/50 text-indigo-300 font-mono text-[11px]"
                            >
                              📄 {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Metrics Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                      <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                          Estimated Cost
                        </span>
                        <span className="text-sm font-bold font-mono text-amber-400 mt-0.5 block">
                          ${(item.costUsd ?? 0).toFixed(4)}
                        </span>
                      </div>

                      <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                          Tokens Processed
                        </span>
                        <span className="text-sm font-bold font-mono text-emerald-400 mt-0.5 block">
                          {fmtCompact((item.tokensIn ?? 0) + (item.tokensOut ?? 0))}
                        </span>
                      </div>

                      <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                          Latency
                        </span>
                        <span className="text-sm font-bold font-mono text-sky-400 mt-0.5 block">
                          {item.durationMs !== undefined && item.durationMs > 0
                            ? `${item.durationMs}ms`
                            : "0ms"}
                        </span>
                      </div>

                      <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                        <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                          Cache Efficiency
                        </span>
                        <span className="text-sm font-bold font-mono text-indigo-400 mt-0.5 block">
                          {(() => {
                            const cacheRead = item.tokensCacheRead ?? 0;
                            const totalIn = item.tokensIn ?? 0;
                            if (totalIn > 0 && cacheRead > 0) {
                              const pct = Math.min(
                                100,
                                Math.round((cacheRead / (totalIn + cacheRead)) * 100)
                              );
                              return `~${pct}% cache hit`;
                            }
                            return cacheRead > 0
                              ? `${fmtCompact(cacheRead)} cached`
                              : "0% cache hit";
                          })()}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
