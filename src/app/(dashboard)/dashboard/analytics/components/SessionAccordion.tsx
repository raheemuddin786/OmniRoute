"use client";

import React, { useState } from "react";
import { PromptListItem, type PromptItemData } from "./PromptListItem";
import { copyToClipboard } from "@/shared/utils/clipboard";
import {
  generatePromptsCSV,
  generatePromptsJSON,
  downloadFile,
  type PromptExportRecord,
} from "@/shared/utils/promptExport";

export interface SessionGroupData {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  turnCount: number;
  prompts: PromptItemData[];
  totalTokens?: number;
  totalCostUsd?: number;
  modelUsed?: string;
  toolsCount?: number;
}

interface SessionAccordionProps {
  session: SessionGroupData;
  index: number;
  projectName?: string;
  defaultExpanded?: boolean;
}

export function SessionAccordion({
  session,
  index,
  projectName = "Active Workspace",
  defaultExpanded = false,
}: SessionAccordionProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [copiedSession, setCopiedSession] = useState<boolean>(false);

  const safeLastSeenAt = session?.lastSeenAt || session?.firstSeenAt || "";
  const formattedDate = safeLastSeenAt
    ? (() => {
        try {
          const d = new Date(safeLastSeenAt);
          return isNaN(d.getTime())
            ? safeLastSeenAt
            : d.toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
        } catch {
          return safeLastSeenAt;
        }
      })()
    : "Recent";

  // First user prompt preview in the session to give an instant conversation topic indication
  const firstPrompt = session?.prompts?.[0]?.prompt || "";
  const firstLinePreview =
    firstPrompt
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "Conversation session";
  const sessionTopic =
    firstLinePreview.length > 80 ? `${firstLinePreview.slice(0, 80)}...` : firstLinePreview;

  const handleCopySessionAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const allText = session.prompts
      .map((p, idx) => {
        const sys = typeof p.systemPrompt === "string" ? p.systemPrompt : "";
        const usr = typeof p.prompt === "string" ? p.prompt : "";
        const resp = typeof p.responseSummary === "string" ? p.responseSummary : "";
        const ts = typeof p.timestamp === "string" ? p.timestamp : "";
        const sysHeader = sys ? `\n[System Directives]\n${sys}\n` : "";
        const respSection = resp ? `\n\n[Agent Response]\n${resp}` : "";
        return `--- Turn #${idx + 1} (${ts}) ---${sysHeader}\n[User Prompt]\n${usr}${respSection}`;
      })
      .join("\n\n");
    const ok = await copyToClipboard(allText);
    if (ok) {
      setCopiedSession(true);
      setTimeout(() => setCopiedSession(false), 2000);
    }
  };

  const handleExportSession = (e: React.MouseEvent, format: "json" | "csv") => {
    e.stopPropagation();
    const exportRecords: PromptExportRecord[] = session.prompts.map((p) => ({
      prompt: typeof p.prompt === "string" ? p.prompt : "",
      systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt : undefined,
      timestamp: typeof p.timestamp === "string" ? p.timestamp : "",
      project: projectName,
      model: p.model || session.modelUsed,
      costUsd: p.costUsd,
      tokensIn: p.tokensIn,
      tokensOut: p.tokensOut,
      toolsUsed: p.toolsUsed,
    }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const cleanSessionName = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);

    if (format === "csv") {
      const csv = generatePromptsCSV(exportRecords);
      downloadFile(csv, `session-${cleanSessionName}-${dateStr}.csv`, "text/csv");
    } else {
      const json = generatePromptsJSON(exportRecords, {
        projectName,
        totalSessions: 1,
      });
      downloadFile(json, `session-${cleanSessionName}-${dateStr}.json`, "application/json");
    }
  };

  return (
    <div
      className={`border rounded-xl transition-all overflow-hidden ${
        expanded
          ? "bg-slate-900/90 border-slate-700 shadow-md ring-1 ring-slate-700/50"
          : "bg-slate-950/40 border-slate-800/80 hover:border-slate-700 hover:bg-slate-900/20"
      }`}
    >
      {/* Session Level Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="p-4 flex items-center justify-between cursor-pointer gap-3 select-none bg-slate-900/50"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className={`text-slate-400 text-xs transition-transform duration-200 shrink-0 ${
              expanded ? "rotate-90 text-indigo-400" : ""
            }`}
          >
            ▶
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-100 text-sm">Session #{index + 1}</span>
              <span
                className="font-mono text-xs text-slate-400 truncate max-w-[200px]"
                title={session.sessionId}
              >
                {session.sessionId.startsWith("conv_") || session.sessionId.startsWith("session_")
                  ? session.sessionId.slice(0, 16)
                  : session.sessionId}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-medium">
                {session.prompts.length} prompt turn{session.prompts.length !== 1 ? "s" : ""}
              </span>
              {session.modelUsed && (
                <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  {session.modelUsed}
                </span>
              )}
              {session.prompts.some((p) => p.systemPrompt) && (
                <span
                  className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-purple-500/15 text-purple-300 border border-purple-500/30"
                  title="Session contains active system directives"
                >
                  🛡️ Directives
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1 text-xs text-slate-400">
              <span className="text-slate-500">Topic:</span>
              <span className="text-slate-300 truncate max-w-md font-medium">{sessionTopic}</span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-500">Last active: {formattedDate}</span>
            </div>
          </div>
        </div>

        {/* Action Controls for the Session */}
        <div className="flex items-center gap-2 shrink-0">
          {session.totalCostUsd !== undefined && session.totalCostUsd > 0 && (
            <span className="text-xs font-mono text-amber-400 hidden sm:inline-block">
              ${session.totalCostUsd.toFixed(4)}
            </span>
          )}

          <button
            type="button"
            onClick={handleCopySessionAll}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors border ${
              copiedSession
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                : "bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700"
            }`}
            title="Copy full conversation flow across all turns"
          >
            {copiedSession ? "✓ Copied Session" : "📋 Copy Session Flow"}
          </button>

          <div className="hidden md:flex items-center rounded-lg border border-slate-700/80 overflow-hidden text-xs">
            <button
              type="button"
              onClick={(e) => handleExportSession(e, "json")}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors border-r border-slate-700"
              title="Export session to JSON"
            >
              JSON
            </button>
            <button
              type="button"
              onClick={(e) => handleExportSession(e, "csv")}
              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Export session to CSV"
            >
              CSV
            </button>
          </div>
        </div>
      </div>

      {/* Prompts Chronology within Session */}
      {expanded && (
        <div className="p-4 pt-3 border-t border-slate-800 space-y-3 bg-slate-950/40">
          <div className="flex items-center justify-between text-xs text-slate-400 pb-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold uppercase tracking-wider text-[11px] text-slate-400 flex items-center gap-1.5">
                <span>💬</span>
                Sequential Conversation Flow
              </span>
              <span className="text-[10px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-full">
                Chronological Order (Turn #1 → Turn #{session.prompts.length})
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-500">
              {session.prompts.length} user prompt turn{session.prompts.length !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="space-y-2.5">
            {session.prompts.map((promptItem, pIdx) => (
              <PromptListItem key={pIdx} item={promptItem} index={pIdx} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
