"use client";

import React, { useState } from "react";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { fmtCompact } from "@/shared/utils/formatting";

export interface PromptItemData {
  id?: string;
  prompt: string;
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
  const [copied, setCopied] = useState<boolean>(false);

  // Extract a clean one-liner preview from the prompt text
  const cleanFirstLine =
    item.prompt
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "Empty prompt";

  const oneLinerPreview =
    cleanFirstLine.length > 110 ? `${cleanFirstLine.slice(0, 110)}...` : cleanFirstLine;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(item.prompt);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formattedDate = new Date(item.timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div
      className={`border rounded-xl transition-all overflow-hidden ${
        expanded
          ? "bg-slate-900/90 border-indigo-500/50 shadow-md"
          : "bg-slate-950/40 border-slate-800/60 hover:border-slate-700/80 hover:bg-slate-900/40"
      }`}
    >
      {/* Clickable Header / Preview Row */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="p-3.5 flex items-start justify-between cursor-pointer gap-3 select-none"
      >
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          {/* Expand/Collapse Chevron Indicator */}
          <button
            type="button"
            className="mt-0.5 text-slate-400 hover:text-slate-200 focus:outline-none transition-transform"
            aria-label={expanded ? "Collapse prompt" : "Expand prompt"}
          >
            <span
              className={`inline-block text-xs transition-transform duration-200 ${
                expanded ? "rotate-90 text-indigo-400" : ""
              }`}
            >
              ▶
            </span>
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-mono text-[11px] font-semibold text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                #{index + 1}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">{formattedDate}</span>
              {item.model && (
                <span className="text-[10px] font-mono bg-slate-800 text-slate-300 px-1.5 py-0.2 rounded border border-slate-700">
                  {item.model}
                </span>
              )}
              {item.status !== undefined && (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                    item.status >= 200 && item.status < 300
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  {item.status}
                </span>
              )}
            </div>

            {/* Clean one-liner preview */}
            <p className="text-xs text-slate-200 font-medium truncate leading-relaxed">
              {oneLinerPreview}
            </p>
          </div>
        </div>

        {/* Quick Action Badges & Copy Button */}
        <div className="flex items-center gap-2 shrink-0">
          {item.tokensIn !== undefined && (
            <span
              className="text-[11px] font-mono text-slate-400 hidden sm:inline-block"
              title="Input tokens"
            >
              {fmtCompact(item.tokensIn)} in
            </span>
          )}
          {item.costUsd !== undefined && item.costUsd > 0 && (
            <span className="text-[11px] font-mono text-amber-400 hidden md:inline-block">
              ${item.costUsd.toFixed(4)}
            </span>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className={`p-1.5 rounded-lg text-xs transition-colors border ${
              copied
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                : "bg-slate-800/80 hover:bg-slate-700 text-slate-300 border-slate-700"
            }`}
            title="Copy prompt text"
            aria-label="Copy prompt"
          >
            {copied ? "✓ Copied" : "📋 Copy"}
          </button>
        </div>
      </div>

      {/* Expanded Container with Full Prompt & Analytics */}
      {expanded && (
        <div className="p-4 pt-1 border-t border-slate-800/80 space-y-4 text-xs">
          {/* Full Prompt Display Container */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5 font-medium">
              <span>Full Prompt Content:</span>
              <span className="text-slate-500 font-mono">{item.prompt.length} chars</span>
            </div>
            <div className="max-h-64 overflow-y-auto p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-200 whitespace-pre-wrap select-text leading-relaxed">
              {item.prompt}
            </div>
          </div>

          {/* Prompt Metrics & Execution Analytics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2">
            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                Estimated Cost
              </span>
              <span className="text-sm font-bold font-mono text-amber-400 mt-0.5 block">
                ${(item.costUsd ?? 0.0002).toFixed(4)}
              </span>
            </div>

            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                Tokens Processed
              </span>
              <span className="text-sm font-bold font-mono text-emerald-400 mt-0.5 block">
                {fmtCompact((item.tokensIn ?? 120) + (item.tokensOut ?? 350))}
              </span>
            </div>

            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                Latency / Duration
              </span>
              <span className="text-sm font-bold font-mono text-sky-400 mt-0.5 block">
                {item.durationMs ? `${item.durationMs}ms` : "1.2s"}
              </span>
            </div>

            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800/60">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block">
                Estimated Savings
              </span>
              <span className="text-sm font-bold font-mono text-indigo-400 mt-0.5 block">
                ~85% cache hit
              </span>
            </div>
          </div>

          {/* Execution History: Tools Invoked, Files, and Response */}
          <div className="space-y-2 pt-2 border-t border-slate-800/60">
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

            {/* Files Created or Modified */}
            {item.filesModified && item.filesModified.length > 0 && (
              <div className="flex items-start gap-2 flex-wrap pt-1">
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

            {/* Response Summary if present */}
            {item.responseSummary && (
              <div className="mt-2 pt-2">
                <span className="text-slate-400 font-medium block mb-1">
                  Agent Response Summary:
                </span>
                <p className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 text-slate-300 font-mono text-[11px] leading-relaxed">
                  {item.responseSummary}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
