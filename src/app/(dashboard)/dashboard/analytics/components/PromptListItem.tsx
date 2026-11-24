"use client";

import React, { useState } from "react";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { fmtCompact, extractUserIntent } from "@/shared/utils/formatting";
import type { PromptPipelineStage, ConversationChatMessage } from "@/lib/db/projectRegistry";

export interface PromptItemData {
  id?: string;
  prompt: string;
  rawPrompt?: string;
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
  toolsUsed?: string[];
  filesModified?: string[];
  sessionTag?: string;
  responseSummary?: string;
  responseReasoning?: string;
  chatMessages?: ConversationChatMessage[];
  status?: number;
  provider?: string;
  comboName?: string;
  errorType?: string | null;
  errorSummary?: string | null;
  resilienceActions?: string | null;
  pipelineStages?: PromptPipelineStage[];
  projectId?: string;
  projectName?: string;
  workspaceRoot?: string;
}

interface PromptListItemProps {
  item: PromptItemData;
  index: number;
  defaultExpanded?: boolean;
  onSelectProject?: (projectId: string) => void;
}

export function PromptListItem({
  item,
  index,
  defaultExpanded = false,
  onSelectProject,
}: PromptListItemProps) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(false);
  const [activeTechnicalTab, setActiveTechnicalTab] = useState<
    "tools" | "flow" | "raw" | "system" | "summary"
  >("tools");
  const [promptViewMode, setPromptViewMode] = useState<"clean" | "raw">("clean");
  const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);
  const [copiedUser, setCopiedUser] = useState<boolean>(false);
  const [copiedRaw, setCopiedRaw] = useState<boolean>(false);
  const [copiedAgent, setCopiedAgent] = useState<boolean>(false);
  const [copiedSystem, setCopiedSystem] = useState<boolean>(false);
  const [copiedFull, setCopiedFull] = useState<boolean>(false);
  const [showReasoning, setShowReasoning] = useState<boolean>(false);
  const [expandedToolIndex, setExpandedToolIndex] = useState<string | null>(null);

  // Defensive guards for prompt properties
  const safePrompt = typeof item?.prompt === "string" ? item.prompt : "";
  const safeRawPrompt =
    typeof item?.rawPrompt === "string" && item.rawPrompt ? item.rawPrompt : safePrompt;
  const safeSystemPrompt = typeof item?.systemPrompt === "string" ? item.systemPrompt : undefined;
  const safeResponseSummary =
    typeof item?.responseSummary === "string" && item.responseSummary.trim().length > 0
      ? item.responseSummary
      : undefined;
  const safeResponseReasoning =
    typeof item?.responseReasoning === "string" && item.responseReasoning.trim().length > 0
      ? item.responseReasoning
      : undefined;
  const hasChatMessages = Array.isArray(item?.chatMessages) && item.chatMessages.length > 0;
  const safeTimestamp = typeof item?.timestamp === "string" && item.timestamp ? item.timestamp : "";

  // Extract clean one-liner preview — strip agent scaffolding first so the
  // preview reflects genuine user intent, not injected system context.
  const cleanFirstLine =
    extractUserIntent(safePrompt)
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) || "Empty prompt";

  const oneLinerPreview =
    cleanFirstLine.length > 120 ? `${cleanFirstLine.slice(0, 120)}...` : cleanFirstLine;

  const handleCopyUserPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const success = await copyToClipboard(promptViewMode === "raw" ? safeRawPrompt : safePrompt);
    if (success) {
      if (promptViewMode === "raw") {
        setCopiedRaw(true);
        setTimeout(() => setCopiedRaw(false), 2000);
      } else {
        setCopiedUser(true);
        setTimeout(() => setCopiedUser(false), 2000);
      }
    }
  };

  const handleCopyAgentResponse = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!safeResponseSummary) return;
    const success = await copyToClipboard(safeResponseSummary);
    if (success) {
      setCopiedAgent(true);
      setTimeout(() => setCopiedAgent(false), 2000);
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
      item.model ? `[Model]: ${item.model}` : null,
      item.provider ? `[Provider]: ${item.provider}` : null,
      item.comboName ? `[Combo Strategy]: ${item.comboName}` : null,
      safeSystemPrompt ? `[System Directives]\n${safeSystemPrompt}\n` : null,
      `[User Prompt]\n${safePrompt}`,
      safeResponseSummary ? `\n[Agent Response]\n${safeResponseSummary}` : null,
      item.resilienceActions ? `\n[Resilience Telemetry]: ${item.resilienceActions}` : null,
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

  // Calculate prompt cache efficiency
  const cacheRead = item.tokensCacheRead ?? 0;
  const totalIn = item.tokensIn ?? 0;
  const cacheRatioPct =
    totalIn > 0 && cacheRead > 0
      ? Math.min(100, Math.round((cacheRead / (totalIn + cacheRead)) * 100))
      : 0;

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
          <span className="font-mono text-xs font-semibold text-indigo-300 bg-indigo-500/15 px-2 py-0.5 rounded-md border border-indigo-500/30 shrink-0 mt-0.5">
            Turn #{index + 1}
          </span>

          <div className="min-w-0 flex-1">
            {/* Metadata Line */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-xs text-slate-400 font-mono flex items-center gap-1">
                <span>🕒</span>
                {formattedDate}
              </span>

              {item.model && (
                <span className="text-xs font-mono bg-slate-800/90 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                  {item.model}
                </span>
              )}

              {item.status !== undefined && (
                <span
                  className={`text-xs font-mono px-1.5 py-0.5 rounded border ${
                    item.status >= 200 && item.status < 300
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}
                >
                  HTTP {item.status}
                </span>
              )}

              {cacheRatioPct > 0 && (
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30"
                  title="Prompt tokens served from cache"
                >
                  ⚡ {cacheRatioPct}% cached
                </span>
              )}

              {item.provider && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-slate-800 text-slate-300 border-slate-700">
                  {item.provider}
                </span>
              )}

              {item.toolsUsed && item.toolsUsed.length > 0 && (
                <span className="text-xs font-mono px-1.5 py-0.5 rounded border bg-amber-500/10 text-amber-300 border-amber-500/20">
                  🛠️ {item.toolsUsed.length} tool{item.toolsUsed.length !== 1 ? "s" : ""}
                </span>
              )}

              {item.resilienceActions && (
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded border bg-cyan-500/15 text-cyan-300 border-cyan-500/30"
                  title={item.resilienceActions}
                >
                  🛡️ Resilience
                </span>
              )}

              {/* Project / Workspace Badge */}
              {(item.projectName || item.workspaceRoot) && (
                <span
                  onClick={
                    item.projectId && onSelectProject
                      ? (e) => {
                          e.stopPropagation();
                          onSelectProject(item.projectId!);
                        }
                      : undefined
                  }
                  className={`text-xs font-mono px-1.5 py-0.5 rounded border bg-emerald-950/40 text-emerald-300 border-emerald-800/40 flex items-center gap-1 ${
                    item.projectId && onSelectProject
                      ? "cursor-pointer hover:bg-emerald-900/60 hover:text-emerald-200 hover:border-emerald-600 transition-colors"
                      : ""
                  }`}
                  title={
                    item.projectId && onSelectProject
                      ? `Jump to project: ${item.projectName || item.projectId}`
                      : item.workspaceRoot
                        ? `Workspace: ${item.workspaceRoot}`
                        : `Project: ${item.projectName}`
                  }
                >
                  <span>📁</span>
                  <span
                    className={
                      item.projectId && onSelectProject ? "underline underline-offset-2" : ""
                    }
                  >
                    {item.projectName || item.workspaceRoot?.split("/").pop()}
                  </span>
                </span>
              )}

              {/* Session Tag Badge */}
              {item.sessionTag && (
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded border bg-purple-950/40 text-purple-300 border-purple-800/40 flex items-center gap-1"
                  title={`Session Tag: ${item.sessionTag}`}
                >
                  <span>💬</span>
                  <span>
                    {item.sessionTag.startsWith("conv_")
                      ? item.sessionTag.slice(5, 13)
                      : item.sessionTag.slice(0, 8)}
                  </span>
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
              className="text-xs font-mono text-slate-400 hidden sm:inline-block"
              title="Input tokens"
            >
              {fmtCompact(item.tokensIn)} tokens
            </span>
          )}

          {item.costUsd !== undefined && item.costUsd > 0 && (
            <span className="text-xs font-mono text-amber-400 hidden md:inline-block">
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

      {/* Expanded Container: Interactive Chat Dialogue View (User vs Assistant) */}
      {expanded && (
        <div className="p-4 pt-2 border-t border-slate-800/80 space-y-4 text-xs bg-slate-950/40">
          {/* Quick Actions Bar */}
          <div className="flex items-center justify-between text-xs pb-1 border-b border-slate-800/60">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <span>💬</span>
              Conversation Dialogue (Turn #{index + 1})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyFullRecord}
                className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors"
                title="Copy complete session turn with system context and telemetry"
              >
                {copiedFull ? "✓ Full Turn Copied" : "📋 Copy Turn"}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTechnicalDetails(!showTechnicalDetails);
                }}
                className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 transition-colors flex items-center gap-1"
              >
                <span>
                  ⚙️ {showTechnicalDetails ? "Hide Pipeline Details" : "Show Pipeline Details"}
                </span>
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

          {/* TWO-SIDED CHAT BUBBLE VIEW OR MULTI-TURN CHAT THREAD */}
          <div className="space-y-3.5 pt-1">
            {hasChatMessages ? (
              /* Full Multi-Turn Interactive Conversation Thread */
              <div className="space-y-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400 pb-1 border-b border-slate-800/50">
                  <span className="font-mono">
                    Thread View ({item.chatMessages!.length} messages)
                  </span>
                  <span className="text-slate-500">Chronological turn order</span>
                </div>
                {item.chatMessages!.map((msg, mIdx) => {
                  const msgFormattedTime = msg.timestamp
                    ? (() => {
                        try {
                          const d = new Date(msg.timestamp);
                          return isNaN(d.getTime())
                            ? ""
                            : d.toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                              });
                        } catch {
                          return "";
                        }
                      })()
                    : "";

                  if (msg.role === "system") {
                    return (
                      <div
                        key={mIdx}
                        className="mx-auto max-w-xl p-2.5 rounded-lg bg-purple-950/20 border border-purple-800/40 text-purple-200 text-xs"
                      >
                        <div className="flex items-center justify-between text-[11px] mb-1 pb-1 border-b border-purple-800/30">
                          <span className="flex items-center gap-1.5 font-semibold text-purple-300">
                            <span>🛡️</span> System Directive
                          </span>
                          {msgFormattedTime && (
                            <span className="text-purple-400/70 font-mono text-xs">
                              {msgFormattedTime}
                            </span>
                          )}
                        </div>
                        <div className="font-mono text-xs whitespace-pre-wrap select-text leading-relaxed max-h-40 overflow-y-auto">
                          {msg.content}
                        </div>
                      </div>
                    );
                  }

                  if (msg.role === "user") {
                    const intentContent = extractUserIntent(msg.content);
                    // Filter out internal scaffolding tool output messages falsely marked as user
                    if (
                      !intentContent ||
                      intentContent.startsWith("<system-reminder>") ||
                      intentContent.startsWith("Called the Read tool") ||
                      intentContent.startsWith("Result of calling the Read tool")
                    ) {
                      return null;
                    }
                    return (
                      <div key={mIdx} className="flex items-start gap-3 justify-end">
                        <div className="flex-1 max-w-2xl bg-indigo-950/40 border border-indigo-700/50 rounded-2xl rounded-tr-sm p-3.5 shadow-sm space-y-2">
                          <div className="flex items-center justify-between text-xs pb-1 border-b border-indigo-800/40">
                            <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                              <span>👤</span> User
                            </span>
                            <div className="flex items-center gap-2">
                              {msgFormattedTime && (
                                <span className="text-indigo-400/70 font-mono text-xs">
                                  {msgFormattedTime}
                                </span>
                              )}
                              <span className="text-indigo-400/80 font-mono text-[11px]">
                                {intentContent.length} chars
                              </span>
                            </div>
                          </div>
                          <div className="font-mono text-xs text-indigo-100 whitespace-pre-wrap select-text leading-relaxed max-h-72 overflow-y-auto">
                            {intentContent}
                          </div>
                        </div>
                        <div
                          className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-semibold shrink-0 mt-0.5 shadow-sm"
                          title="User"
                        >
                          👤
                        </div>
                      </div>
                    );
                  }

                  if (msg.role === "tool") {
                    return (
                      <div key={mIdx} className="flex items-start gap-3 justify-start pl-11">
                        <div className="flex-1 max-w-2xl bg-amber-950/20 border border-amber-800/40 rounded-xl p-2.5 shadow-sm space-y-1.5">
                          <div className="flex items-center justify-between text-[11px] text-amber-300">
                            <span className="font-mono flex items-center gap-1.5">
                              <span>🔧</span> Tool Output ({msg.toolName || "tool"})
                            </span>
                            <div className="flex items-center gap-2">
                              {msgFormattedTime && (
                                <span className="text-amber-400/60 font-mono text-xs">
                                  {msgFormattedTime}
                                </span>
                              )}
                              <span className="font-mono text-amber-400/70">
                                {msg.content.length} chars
                              </span>
                            </div>
                          </div>
                          <div className="font-mono text-xs text-amber-100 whitespace-pre-wrap select-text leading-relaxed max-h-48 overflow-y-auto bg-slate-950/60 p-2 rounded border border-amber-900/30">
                            {msg.content}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Assistant role
                  return (
                    <div key={mIdx} className="flex items-start gap-3 justify-start">
                      <div
                        className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-200 text-xs shrink-0 mt-0.5 shadow-sm"
                        title="AI Assistant"
                      >
                        🤖
                      </div>
                      <div className="flex-1 max-w-2xl bg-slate-900/90 border border-slate-800 rounded-2xl rounded-tl-sm p-3.5 shadow-sm space-y-2">
                        <div className="flex items-center justify-between text-xs pb-1 border-b border-slate-800">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                              <span>🤖</span> Assistant
                            </span>
                            {item.model && (
                              <span className="font-mono text-xs bg-slate-800 text-slate-300 px-1.5 py-0.2 rounded border border-slate-700">
                                {item.model}
                              </span>
                            )}
                          </div>
                          {msgFormattedTime && (
                            <span className="text-slate-500 font-mono text-xs">
                              {msgFormattedTime}
                            </span>
                          )}
                        </div>

                        {/* Collapsible Reasoning Block if present */}
                        {msg.reasoningContent && (
                          <div className="rounded-lg bg-indigo-950/30 border border-indigo-800/40 overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setShowReasoning(!showReasoning)}
                              className="w-full flex items-center justify-between p-2 text-xs text-indigo-300 hover:bg-indigo-900/20 transition-colors"
                            >
                              <span className="flex items-center gap-1.5 font-medium">
                                <span>🧠</span> Thought Process / Reasoning
                              </span>
                              <span className="font-mono text-[10px] text-indigo-400">
                                {showReasoning ? "▾ Collapse" : "▸ Expand"}
                              </span>
                            </button>
                            {showReasoning && (
                              <div className="p-2.5 pt-1 border-t border-indigo-800/30 font-mono text-xs text-indigo-200 whitespace-pre-wrap select-text leading-relaxed max-h-60 overflow-y-auto bg-slate-950/50">
                                {msg.reasoningContent}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Tool Calls execution list if present */}
                        {msg.toolCalls && msg.toolCalls.length > 0 && (
                          <div className="space-y-1.5 pt-1">
                            <div className="flex flex-col gap-1.5">
                              {msg.toolCalls.map((tc, tcIdx) => {
                                const toolKey = `${mIdx}-${tcIdx}`;
                                const isSelected = expandedToolIndex === toolKey;
                                const rawArgs = tc.arguments;
                                const parsedArgs: Record<string, unknown> | null =
                                  typeof rawArgs === "object" && rawArgs !== null
                                    ? (rawArgs as Record<string, unknown>)
                                    : typeof rawArgs === "string"
                                      ? (() => {
                                          try {
                                            return JSON.parse(rawArgs);
                                          } catch {
                                            return null;
                                          }
                                        })()
                                      : null;

                                const targetPath =
                                  (parsedArgs?.path as string) ||
                                  (parsedArgs?.file_path as string) ||
                                  (parsedArgs?.target_file as string) ||
                                  (parsedArgs?.file as string) ||
                                  "";

                                const commandStr =
                                  (parsedArgs?.command as string) ||
                                  (parsedArgs?.cmd as string) ||
                                  "";

                                const labelDetail = targetPath
                                  ? targetPath.split("/").pop()
                                  : commandStr
                                    ? commandStr.slice(0, 35) +
                                      (commandStr.length > 35 ? "..." : "")
                                    : "";

                                return (
                                  <div key={tcIdx} className="w-full">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedToolIndex(isSelected ? null : toolKey)
                                      }
                                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/70 text-xs font-mono text-slate-200 hover:text-white transition-all shadow-sm"
                                    >
                                      <span className="text-amber-400 font-semibold">
                                        {tc.name}
                                      </span>
                                      {labelDetail && (
                                        <span className="text-slate-300 font-normal">
                                          {labelDetail}
                                        </span>
                                      )}
                                      <span className="text-[10px] text-slate-400 ml-1">
                                        {isSelected ? "▾" : "▸"}
                                      </span>
                                    </button>
                                    {isSelected && rawArgs && (
                                      <pre className="mt-1.5 p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 whitespace-pre-wrap overflow-x-auto shadow-inner leading-relaxed">
                                        {typeof rawArgs === "object"
                                          ? JSON.stringify(rawArgs, null, 2)
                                          : String(rawArgs)}
                                      </pre>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Assistant text content */}
                        {msg.content ? (
                          <div className="font-mono text-xs text-slate-200 whitespace-pre-wrap select-text leading-relaxed max-h-72 overflow-y-auto">
                            {msg.content}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Fallback Single-Turn Request / Response Bubble View */
              <>
                {/* 1. USER MESSAGE BUBBLE */}
                <div className="flex items-start gap-3 justify-end">
                  <div className="flex-1 max-w-2xl bg-indigo-950/40 border border-indigo-700/50 rounded-2xl rounded-tr-sm p-3.5 shadow-sm space-y-2">
                    <div className="flex items-center justify-between text-xs pb-1 border-b border-indigo-800/40">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-indigo-300 flex items-center gap-1.5">
                          <span>👤</span>
                          User Prompt
                        </span>
                        {safeRawPrompt !== safePrompt && (
                          <div className="inline-flex rounded-md border border-indigo-700/60 bg-indigo-900/60 p-0.5 text-[10px]">
                            <button
                              type="button"
                              onClick={() => setPromptViewMode("clean")}
                              className={`px-1.5 py-0.5 rounded transition-colors ${
                                promptViewMode === "clean"
                                  ? "bg-indigo-600 text-white font-medium"
                                  : "text-indigo-300 hover:text-white"
                              }`}
                            >
                              Intent
                            </button>
                            <button
                              type="button"
                              onClick={() => setPromptViewMode("raw")}
                              className={`px-1.5 py-0.5 rounded transition-colors ${
                                promptViewMode === "raw"
                                  ? "bg-indigo-600 text-white font-medium"
                                  : "text-indigo-300 hover:text-white"
                              }`}
                            >
                              Raw Request
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-indigo-400/80 font-mono text-xs">
                          {(promptViewMode === "raw" ? safeRawPrompt : safePrompt).length} chars
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyUserPrompt}
                          className="text-xs text-indigo-300 hover:text-white transition-colors"
                          title={
                            promptViewMode === "raw" ? "Copy raw prompt" : "Copy extracted prompt"
                          }
                        >
                          {promptViewMode === "raw"
                            ? copiedRaw
                              ? "✓ Copied Raw"
                              : "Copy Raw"
                            : copiedUser
                              ? "✓ Copied"
                              : "Copy"}
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-xs text-indigo-100 whitespace-pre-wrap select-text leading-relaxed max-h-72 overflow-y-auto">
                      {promptViewMode === "raw" ? safeRawPrompt : safePrompt}
                    </div>
                  </div>
                  <div
                    className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-semibold shrink-0 mt-0.5 shadow-sm"
                    title="User"
                  >
                    👤
                  </div>
                </div>

                {/* 2. ASSISTANT / AGENT RESPONSE BUBBLE */}
                <div className="flex items-start gap-3 justify-start">
                  <div
                    className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-200 text-xs shrink-0 mt-0.5 shadow-sm"
                    title="AI Assistant"
                  >
                    🤖
                  </div>
                  <div className="flex-1 max-w-2xl bg-slate-900/90 border border-slate-800 rounded-2xl rounded-tl-sm p-3.5 shadow-sm space-y-2">
                    <div className="flex items-center justify-between text-xs pb-1 border-b border-slate-800">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                          <span>🤖</span>
                          Assistant Response
                        </span>
                        {item.model && (
                          <span className="font-mono text-xs bg-slate-800 text-slate-300 px-1.5 py-0.2 rounded border border-slate-700">
                            {item.model}
                          </span>
                        )}
                      </div>
                      {safeResponseSummary && (
                        <button
                          type="button"
                          onClick={handleCopyAgentResponse}
                          className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                          title="Copy agent response"
                        >
                          {copiedAgent ? "✓ Copied" : "Copy"}
                        </button>
                      )}
                    </div>

                    {/* Thinking / Reasoning Section if present */}
                    {safeResponseReasoning && (
                      <div className="rounded-lg bg-indigo-950/30 border border-indigo-800/40 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setShowReasoning(!showReasoning)}
                          className="w-full flex items-center justify-between p-2 text-xs text-indigo-300 hover:bg-indigo-900/20 transition-colors"
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            <span>🧠</span> Thought Process / Reasoning
                          </span>
                          <span className="font-mono text-[10px] text-indigo-400">
                            {showReasoning ? "▾ Collapse" : "▸ Expand"}
                          </span>
                        </button>
                        {showReasoning && (
                          <div className="p-2.5 pt-1 border-t border-indigo-800/30 font-mono text-xs text-indigo-200 whitespace-pre-wrap select-text leading-relaxed max-h-60 overflow-y-auto bg-slate-950/50">
                            {safeResponseReasoning}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Compact Tool Invocations if tools were used in this turn */}
                    {item.toolsUsed && item.toolsUsed.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {item.toolsUsed.map((toolName, tIdx) => {
                          const matchedFile = item.filesModified?.[tIdx] || item.filesModified?.[0];
                          const fileBaseName = matchedFile ? matchedFile.split("/").pop() : "";
                          return (
                            <span
                              key={tIdx}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700/70 text-xs font-mono text-slate-200 shadow-sm"
                            >
                              <span className="text-amber-400 font-semibold">{toolName}</span>
                              {fileBaseName && (
                                <span className="text-slate-300">{fileBaseName}</span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {safeResponseSummary ? (
                      <div className="font-mono text-xs text-slate-200 whitespace-pre-wrap select-text leading-relaxed max-h-72 overflow-y-auto">
                        {safeResponseSummary}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 italic py-1">
                        Response stream completed ({item.durationMs || 0}ms latency, HTTP{" "}
                        {item.status ?? 200}).
                      </div>
                    )}

                    {/* Error Summary Callout if failed */}
                    {item.errorSummary && (
                      <div className="mt-2 p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-200 text-xs flex items-start gap-2">
                        <span className="text-sm shrink-0">⚠️</span>
                        <div>
                          <span className="font-semibold text-rose-300 block">
                            {item.errorType ? `Error (${item.errorType}):` : "Execution Error:"}
                          </span>
                          <p className="mt-0.5 font-mono text-xs">{item.errorSummary}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 3. PIPELINE & TECHNICAL EXECUTION DRAWER */}
          {showTechnicalDetails && (
            <div className="mt-4 pt-3 border-t border-slate-800 space-y-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">
              {/* Navigation Tabs for Technical Subviews */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setActiveTechnicalTab("flow")}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      activeTechnicalTab === "flow"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    🔄 Lifecycle Graph
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTechnicalTab("tools")}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      activeTechnicalTab === "tools"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    ⚡ Pipeline Telemetry
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTechnicalTab("raw")}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      activeTechnicalTab === "raw"
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    📝 Raw Payload
                  </button>
                  {safeSystemPrompt && (
                    <button
                      type="button"
                      onClick={() => setActiveTechnicalTab("system")}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
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
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        activeTechnicalTab === "summary"
                          ? "bg-slate-700 text-white shadow-sm"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      📋 Raw Response
                    </button>
                  )}
                </div>

                {activeTechnicalTab === "system" && safeSystemPrompt && (
                  <button
                    type="button"
                    onClick={handleCopySystemPrompt}
                    className="px-2 py-0.5 text-xs rounded bg-purple-950/60 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30 transition-colors"
                  >
                    {copiedSystem ? "✓ Copied Directives" : "📋 Copy Directives"}
                  </button>
                )}
              </div>

              {/* Subview 0: Lifecycle Interactive Graph */}
              {activeTechnicalTab === "flow" && (
                <div className="space-y-3 pt-1">
                  <div className="bg-slate-950/90 p-3.5 rounded-xl border border-slate-800">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                        <span>🔄</span>
                        Interactive Request Lifecycle Flow
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Click any node to inspect layer metadata
                      </span>
                    </div>

                    {/* Flowchart Nodes Container */}
                    <div className="flex items-center gap-1 overflow-x-auto py-2.5 px-1 scrollbar-thin">
                      {(item.pipelineStages && item.pipelineStages.length > 0
                        ? item.pipelineStages
                        : [
                            {
                              name: "User Input",
                              type: "client_input" as const,
                              status: "success" as const,
                              details: { length: (safeRawPrompt || safePrompt).length },
                            },
                            {
                              name: "Guard & Context",
                              type: "guardrail" as const,
                              status: "success" as const,
                              details: { invariants: Boolean(item.resilienceActions) },
                            },
                            {
                              name: "Strategy & Route",
                              type: "routing" as const,
                              status: "success" as const,
                              details: {
                                strategy: item.comboName || "direct",
                                target: item.model || "default",
                              },
                            },
                            {
                              name: "Cache & Tokens",
                              type: "compression" as const,
                              status: "success" as const,
                              details: { cacheRatio: `${cacheRatioPct}%` },
                            },
                            {
                              name: "LLM Dispatch",
                              type: "llm_dispatch" as const,
                              durationMs: item.durationMs,
                              status: (item.status && item.status >= 400
                                ? "error"
                                : "success") as const,
                              details: {
                                status: item.status ?? 200,
                                latency: `${item.durationMs || 0}ms`,
                              },
                            },
                            ...(item.toolsUsed && item.toolsUsed.length > 0
                              ? [
                                  {
                                    name: "Tool Loop",
                                    type: "tool_execution" as const,
                                    status: "success" as const,
                                    details: {
                                      tools: item.toolsUsed,
                                      files: item.filesModified || [],
                                    },
                                  },
                                ]
                              : []),
                            {
                              name: "Response Out",
                              type: "response_eval" as const,
                              status: (item.status && item.status >= 400
                                ? "error"
                                : "success") as const,
                              details: { status: item.status ?? 200 },
                            },
                          ]
                      ).map((stage, sIdx, arr) => {
                        const isSelected = selectedNodeIndex === sIdx;
                        const isError = stage.status === "error";
                        const isWarn = stage.status === "warning";

                        const nodeBg = isSelected
                          ? "bg-indigo-600 border-indigo-400 text-white shadow-lg ring-2 ring-indigo-400/40"
                          : isError
                            ? "bg-rose-950/60 border-rose-700/70 text-rose-200 hover:border-rose-500"
                            : isWarn
                              ? "bg-amber-950/60 border-amber-700/70 text-amber-200 hover:border-amber-500"
                              : "bg-slate-900 border-slate-700 text-slate-200 hover:border-indigo-500 hover:bg-slate-800";

                        const iconMap: Record<string, string> = {
                          client_input: "👤",
                          guardrail: "🛡️",
                          routing: "🔀",
                          compression: "⚡",
                          llm_dispatch: "🤖",
                          tool_execution: "🛠️",
                          response_eval: "📤",
                        };

                        return (
                          <React.Fragment key={sIdx}>
                            <div
                              onClick={() => setSelectedNodeIndex(isSelected ? null : sIdx)}
                              className={`cursor-pointer transition-all duration-150 px-3 py-2 rounded-lg border flex flex-col items-center min-w-[110px] shrink-0 text-center select-none ${nodeBg}`}
                            >
                              <div className="flex items-center gap-1 text-[11px] font-semibold">
                                <span>{iconMap[stage.type] || "🔹"}</span>
                                <span className="truncate max-w-[95px]">{stage.name}</span>
                              </div>
                              <span className="text-[10px] opacity-80 font-mono mt-0.5">
                                {stage.durationMs ? `${stage.durationMs}ms` : stage.status}
                              </span>
                            </div>
                            {sIdx < arr.length - 1 && (
                              <div className="text-slate-500 shrink-0 px-1 font-semibold select-none text-xs">
                                ➔
                              </div>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>

                    {/* Selected Node Details Box */}
                    {selectedNodeIndex !== null && (
                      <div className="mt-3 p-3 rounded-lg bg-slate-900 border border-indigo-500/40 text-xs">
                        {(() => {
                          const stages =
                            item.pipelineStages && item.pipelineStages.length > 0
                              ? item.pipelineStages
                              : [
                                  {
                                    name: "User Input",
                                    type: "client_input",
                                    status: "success",
                                    details: { length: (safeRawPrompt || safePrompt).length },
                                  },
                                  {
                                    name: "Guard & Context",
                                    type: "guardrail",
                                    status: "success",
                                    details: { invariants: Boolean(item.resilienceActions) },
                                  },
                                  {
                                    name: "Strategy & Route",
                                    type: "routing",
                                    status: "success",
                                    details: {
                                      strategy: item.comboName || "direct",
                                      target: item.model || "default",
                                    },
                                  },
                                  {
                                    name: "Cache & Tokens",
                                    type: "compression",
                                    status: "success",
                                    details: { cacheRatio: `${cacheRatioPct}%` },
                                  },
                                  {
                                    name: "LLM Dispatch",
                                    type: "llm_dispatch",
                                    durationMs: item.durationMs,
                                    status: item.status && item.status >= 400 ? "error" : "success",
                                    details: {
                                      status: item.status ?? 200,
                                      latency: `${item.durationMs || 0}ms`,
                                    },
                                  },
                                  ...(item.toolsUsed && item.toolsUsed.length > 0
                                    ? [
                                        {
                                          name: "Tool Loop",
                                          type: "tool_execution",
                                          status: "success",
                                          details: {
                                            tools: item.toolsUsed,
                                            files: item.filesModified || [],
                                          },
                                        },
                                      ]
                                    : []),
                                  {
                                    name: "Response Out",
                                    type: "response_eval",
                                    status: item.status && item.status >= 400 ? "error" : "success",
                                    details: { status: item.status ?? 200 },
                                  },
                                ];
                          const curr = stages[selectedNodeIndex];
                          if (!curr) return null;
                          return (
                            <div>
                              <div className="flex items-center justify-between pb-1.5 border-b border-slate-800">
                                <span className="font-semibold text-indigo-300">
                                  Layer #{selectedNodeIndex + 1}: {curr.name} ({curr.type})
                                </span>
                                <span className="font-mono text-[11px] text-slate-400">
                                  Status: {curr.status}
                                </span>
                              </div>
                              <pre className="mt-2 font-mono text-[11px] text-slate-300 bg-slate-950 p-2 rounded border border-slate-800/80 overflow-x-auto">
                                {typeof curr.details === "object"
                                  ? JSON.stringify(curr.details, null, 2)
                                  : String(curr.details || "No further details")}
                              </pre>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Subview: Raw Payload & Prompt Comparison */}
              {activeTechnicalTab === "raw" && (
                <div className="space-y-3 pt-1">
                  <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                        Raw Client Request vs Filtered Intent
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          await copyToClipboard(safeRawPrompt);
                          setCopiedRaw(true);
                          setTimeout(() => setCopiedRaw(false), 2000);
                        }}
                        className="px-2 py-0.5 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                      >
                        {copiedRaw ? "✓ Copied Raw" : "📋 Copy Full Raw Payload"}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1">
                      <div>
                        <span className="text-slate-400 block mb-1 font-medium">
                          Extracted Intent:
                        </span>
                        <div className="max-h-60 overflow-y-auto p-2.5 rounded bg-slate-900 border border-slate-800 font-mono text-slate-200 whitespace-pre-wrap">
                          {safePrompt}
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-400 block mb-1 font-medium">
                          Original Raw Request:
                        </span>
                        <div className="max-h-60 overflow-y-auto p-2.5 rounded bg-slate-900 border border-slate-800 font-mono text-indigo-200 whitespace-pre-wrap">
                          {safeRawPrompt}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Subview 1: Pipeline & Telemetry */}
              {activeTechnicalTab === "tools" && (
                <div className="space-y-3 pt-1">
                  {/* End-to-End Pipeline Techniques Card */}
                  <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 space-y-2">
                    <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                      End-to-End Pipeline Techniques
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                      {/* Provider & Model Routing */}
                      <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800">
                        <span className="text-xs text-slate-400 uppercase font-medium block">
                          Routing & Model
                        </span>
                        <div className="mt-1 space-y-0.5">
                          <div className="text-slate-200 font-mono text-xs">
                            {item.provider || "Default Router"} / {item.model || "Unknown Model"}
                          </div>
                          {item.comboName && (
                            <div className="text-purple-300 font-mono text-xs">
                              Strategy: {item.comboName}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Prompt Cache Optimization */}
                      <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800">
                        <span className="text-xs text-slate-400 uppercase font-medium block">
                          Token Optimization
                        </span>
                        <div className="mt-1 space-y-0.5">
                          <div className="text-emerald-300 font-mono text-xs">
                            {cacheRatioPct > 0
                              ? `⚡ ${cacheRatioPct}% cache hit (${fmtCompact(item.tokensCacheRead)} cached)`
                              : "No cache read for this turn"}
                          </div>
                          {item.tokensCacheCreation ? (
                            <div className="text-slate-400 font-mono text-xs">
                              Created: {fmtCompact(item.tokensCacheCreation)} tokens
                            </div>
                          ) : null}
                          {item.tokensReasoning ? (
                            <div className="text-sky-300 font-mono text-xs">
                              Reasoning: {fmtCompact(item.tokensReasoning)} tokens
                            </div>
                          ) : null}
                        </div>
                      </div>

                      {/* Governance & Resilience Actions */}
                      <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800">
                        <span className="text-xs text-slate-400 uppercase font-medium block">
                          Resilience & Governance
                        </span>
                        <div className="mt-1 space-y-0.5">
                          <div className="text-cyan-300 font-mono text-xs">
                            {item.resilienceActions
                              ? `🛡️ ${item.resilienceActions}`
                              : "Standard pass (no loop / breaker trip)"}
                          </div>
                          <div className="text-slate-400 text-xs">
                            Status: HTTP {item.status ?? 200}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Tool Invocations */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-slate-400 font-medium">Tools Invocations:</span>
                    {item.toolsUsed && item.toolsUsed.length > 0 ? (
                      item.toolsUsed.map((tool, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-mono text-xs"
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
                            className="px-2 py-0.5 rounded bg-indigo-950/50 border border-indigo-800/50 text-indigo-300 font-mono text-xs"
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
                      <span className="text-xs text-slate-400 uppercase tracking-wider block">
                        Estimated Cost
                      </span>
                      <span className="text-sm font-semibold font-mono text-amber-400 mt-0.5 block">
                        ${(item.costUsd ?? 0).toFixed(4)}
                      </span>
                    </div>

                    <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-xs text-slate-400 uppercase tracking-wider block">
                        Tokens Processed
                      </span>
                      <span className="text-sm font-semibold font-mono text-emerald-400 mt-0.5 block">
                        {fmtCompact((item.tokensIn ?? 0) + (item.tokensOut ?? 0))}
                      </span>
                    </div>

                    <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-xs text-slate-400 uppercase tracking-wider block">
                        Latency
                      </span>
                      <span className="text-sm font-semibold font-mono text-sky-400 mt-0.5 block">
                        {item.durationMs !== undefined && item.durationMs > 0
                          ? `${item.durationMs}ms`
                          : "0ms"}
                      </span>
                    </div>

                    <div className="bg-slate-950/80 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-xs text-slate-400 uppercase tracking-wider block">
                        Cache Efficiency
                      </span>
                      <span className="text-sm font-semibold font-mono text-indigo-400 mt-0.5 block">
                        {cacheRatioPct > 0 ? `~${cacheRatioPct}% hit` : "0% hit"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Subview 2: System Directives */}
              {activeTechnicalTab === "system" && safeSystemPrompt && (
                <div>
                  <div className="text-xs text-purple-400 mb-1 font-mono uppercase tracking-wider flex items-center justify-between">
                    <span>System / Developer Directives</span>
                    <span className="text-purple-400/80 font-normal">Context Injected</span>
                  </div>
                  <div className="max-h-60 overflow-y-auto p-3 rounded-lg bg-purple-950/20 border border-purple-500/30 font-mono text-xs text-purple-100 whitespace-pre-wrap select-text leading-relaxed">
                    {safeSystemPrompt}
                  </div>
                </div>
              )}

              {/* Subview 3: Raw Response Summary */}
              {activeTechnicalTab === "summary" && safeResponseSummary && (
                <div>
                  <div className="text-xs text-indigo-400 mb-1 font-mono uppercase tracking-wider">
                    Agent Response Summary
                  </div>
                  <div className="max-h-60 overflow-y-auto p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 whitespace-pre-wrap select-text leading-relaxed">
                    {safeResponseSummary}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
