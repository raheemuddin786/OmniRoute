"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { ProjectRegistry, ProjectAnalytics, ProjectBrief } from "@/lib/db/projectRegistry";

export function ProjectsAnalyticsTab() {
  const [projects, setProjects] = useState<ProjectRegistry[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [calculatingAnalytics, setCalculatingAnalytics] = useState<boolean>(false);
  const [generatingBrief, setGeneratingBrief] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Modal states
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [newBasePath, setNewBasePath] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  const [newDescription, setNewDescription] = useState<string>("");

  // Edit form state
  const [editName, setEditName] = useState<string>("");
  const [editDescription, setEditDescription] = useState<string>("");
  const [editTechStack, setEditTechStack] = useState<string>("");
  const [editCloudStack, setEditCloudStack] = useState<string>("");
  const [editFeatures, setEditFeatures] = useState<string>("");
  const [editMemoryLocations, setEditMemoryLocations] = useState<string>("");

  const showNotice = useCallback((type: "success" | "error" | "info", message: string) => {
    setNotice({ type, message });
    setTimeout(() => setNotice(null), 5000);
  }, []);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch("/api/v1/projects");
        const data = await res.json();
        if (!ignore && data.success && Array.isArray(data.projects)) {
          setProjects(data.projects);
          setSelectedProjectId((prev) => prev ?? data.projects[0]?.id ?? null);
        }
      } catch (_err) {
        if (!ignore) {
          showNotice("error", "Failed to fetch connected projects");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [showNotice]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null;

  const handleOpenEditModal = () => {
    if (selectedProject) {
      setEditName(selectedProject.name);
      setEditDescription(selectedProject.description ?? "");
      setEditTechStack((selectedProject.techStack ?? []).join(", "));
      setEditCloudStack((selectedProject.cloudStack ?? []).join(", "));
      setEditFeatures((selectedProject.features ?? []).join(", "));
      setEditMemoryLocations((selectedProject.memoryLocations ?? []).join(", "));
      setShowEditModal(true);
    }
  };

  const handleCalculateAnalytics = async () => {
    if (!selectedProject) return;
    setCalculatingAnalytics(true);
    try {
      const res = await fetch(`/api/v1/projects/${selectedProject.id}/analytics`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success && data.analytics) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === selectedProject.id
              ? {
                  ...p,
                  analyticsCache: data.analytics,
                  analyticsCachedAt: data.analytics.lastComputedAt,
                }
              : p
          )
        );
        showNotice("success", "Analytics calculated and refreshed successfully");
      } else {
        showNotice("error", data.error || "Failed to calculate analytics");
      }
    } catch {
      showNotice("error", "Error connecting to analytics engine");
    } finally {
      setCalculatingAnalytics(false);
    }
  };

  const handleGenerateBrief = async () => {
    if (!selectedProject) return;
    setGeneratingBrief(true);
    try {
      const res = await fetch(`/api/v1/projects/${selectedProject.id}/brief`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success && data.brief) {
        setProjects((prev) =>
          prev.map((p) =>
            p.id === selectedProject.id
              ? { ...p, briefCache: data.brief, briefGeneratedAt: data.brief.generatedAt }
              : p
          )
        );
        showNotice("success", "Project brief generated and updated");
      } else {
        showNotice("error", data.error || "Failed to generate brief");
      }
    } catch {
      showNotice("error", "Error generating executive brief");
    } finally {
      setGeneratingBrief(false);
    }
  };

  const handleScanDirectory = async () => {
    if (!selectedProject) return;
    setScanning(true);
    try {
      const res = await fetch("/api/v1/projects/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basePath: selectedProject.basePath }),
      });
      const data = await res.json();
      if (data.success && data.scan) {
        const patchRes = await fetch(`/api/v1/projects/${selectedProject.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filesCount: data.scan.filesCount,
            docsCount: data.scan.docsCount,
            techStack: data.scan.techStack,
            cloudStack: data.scan.cloudStack,
            features: data.scan.features,
            memoryLocations: data.scan.memoryLocations,
          }),
        });
        const patchData = await patchRes.json();
        if (patchData.success && patchData.project) {
          setProjects((prev) =>
            prev.map((p) => (p.id === selectedProject.id ? patchData.project : p))
          );
          showNotice(
            "success",
            `Scanned: ${data.scan.filesCount} files, ${data.scan.docsCount} docs found`
          );
        }
      }
    } catch {
      showNotice("error", "Failed to scan filesystem directory");
    } finally {
      setScanning(false);
    }
  };

  const handleRegisterProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBasePath.trim()) return;

    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          basePath: newBasePath.trim(),
          name: newName.trim() || undefined,
          description: newDescription.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success && data.project) {
        setProjects((prev) => [...prev.filter((p) => p.id !== data.project.id), data.project]);
        setSelectedProjectId(data.project.id);
        setShowAddModal(false);
        setNewBasePath("");
        setNewName("");
        setNewDescription("");
        showNotice("success", `Project "${data.project.name}" registered successfully`);
      } else {
        showNotice("error", data.error || "Failed to register project");
      }
    } catch {
      showNotice("error", "Error registering project");
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject) return;

    try {
      const res = await fetch(`/api/v1/projects/${selectedProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim(),
          techStack: editTechStack
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          cloudStack: editCloudStack
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          features: editFeatures
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          memoryLocations: editMemoryLocations
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (data.success && data.project) {
        setProjects((prev) => prev.map((p) => (p.id === selectedProject.id ? data.project : p)));
        setShowEditModal(false);
        showNotice("success", "Project details updated");
      } else {
        showNotice("error", data.error || "Failed to update project");
      }
    } catch (_err) {
      showNotice("error", "Error updating project details");
    }
  };

  const analytics: ProjectAnalytics | null = selectedProject?.analyticsCache ?? null;
  const brief: ProjectBrief | null = selectedProject?.briefCache ?? null;

  return (
    <div className="space-y-6">
      {/* Toast Notice */}
      {notice && (
        <div
          className={`p-4 rounded-xl flex items-center justify-between text-sm shadow-md transition-all ${
            notice.type === "success"
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : notice.type === "error"
                ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
          }`}
        >
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)} className="text-xs opacity-75 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {/* Main Two-Panel Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Panel: Tree & Project List (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/80">
              <div className="flex items-center space-x-2">
                <span className="text-lg">🌿</span>
                <h3 className="font-semibold text-slate-100">Connected Projects</h3>
              </div>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center space-x-1"
              >
                <span>+</span>
                <span>Connect</span>
              </button>
            </div>

            {loading ? (
              <div className="py-8 text-center text-slate-500 text-sm animate-pulse">
                Discovering connected projects...
              </div>
            ) : projects.length === 0 ? (
              <div className="py-8 text-center text-slate-500 text-sm">
                No projects connected yet.
              </div>
            ) : (
              <div className="space-y-2">
                {projects.map((proj) => {
                  const isSelected = proj.id === selectedProjectId;
                  return (
                    <div
                      key={proj.id}
                      onClick={() => setSelectedProjectId(proj.id)}
                      className={`cursor-pointer rounded-xl p-3.5 transition-all border ${
                        isSelected
                          ? "bg-indigo-600/15 border-indigo-500/40 shadow-sm"
                          : "bg-slate-800/40 border-slate-800 hover:bg-slate-800/70 hover:border-slate-700"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2.5 overflow-hidden">
                          <span className="text-base">📦</span>
                          <span
                            className={`font-medium text-sm truncate ${
                              isSelected ? "text-indigo-300" : "text-slate-200"
                            }`}
                          >
                            {proj.name}
                          </span>
                        </div>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${
                            proj.status === "active"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-slate-700 text-slate-400"
                          }`}
                        >
                          {proj.status}
                        </span>
                      </div>

                      <div className="mt-2 text-xs text-slate-400 font-mono truncate">
                        {proj.basePath}
                      </div>

                      <div className="mt-2.5 flex items-center space-x-3 text-[11px] text-slate-400">
                        <span>📁 {proj.filesCount ?? 0} files</span>
                        <span>📄 {proj.docsCount ?? 0} docs</span>
                        {proj.analyticsCachedAt ? (
                          <span className="text-emerald-400 font-medium">⚡ Analyzed</span>
                        ) : (
                          <span className="text-slate-500">⚪ Idle</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Detailed Overview & On-Demand Analytics (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {selectedProject ? (
            <>
              {/* Top Card: Project Meta & Immediate Info */}
              <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center space-x-3">
                      <h2 className="text-xl font-bold text-slate-100">{selectedProject.name}</h2>
                      <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                        {selectedProject.status ?? "active"}
                      </span>
                    </div>
                    <p className="text-xs font-mono text-slate-400 mt-1 select-all">
                      {selectedProject.basePath}
                    </p>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      onClick={handleOpenEditModal}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
                    >
                      ✏️ Edit Info
                    </button>
                    <button
                      onClick={handleScanDirectory}
                      disabled={scanning}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors disabled:opacity-50"
                    >
                      {scanning ? "Scanning..." : "🔍 Scan Files"}
                    </button>
                  </div>
                </div>

                {selectedProject.description && (
                  <p className="text-sm text-slate-300 leading-relaxed">
                    {selectedProject.description}
                  </p>
                )}

                {/* Stacks & Features Badges */}
                <div className="space-y-3 pt-2 border-t border-slate-800/80">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400 font-medium mr-1">Tech Stack:</span>
                    {(selectedProject.techStack ?? []).length > 0 ? (
                      selectedProject.techStack!.map((tech) => (
                        <span
                          key={tech}
                          className="px-2.5 py-1 text-xs rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/20"
                        >
                          {tech}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">Not specified</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400 font-medium mr-1">Cloud Stack:</span>
                    {(selectedProject.cloudStack ?? []).length > 0 ? (
                      selectedProject.cloudStack!.map((cloud) => (
                        <span
                          key={cloud}
                          className="px-2.5 py-1 text-xs rounded-md bg-sky-500/10 text-sky-300 border border-sky-500/20"
                        >
                          {cloud}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">Not specified</span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400 font-medium mr-1">Memory & RAG:</span>
                    {(selectedProject.memoryLocations ?? []).length > 0 ? (
                      selectedProject.memoryLocations!.map((loc) => (
                        <span
                          key={loc}
                          className="px-2.5 py-1 text-xs font-mono rounded-md bg-purple-500/10 text-purple-300 border border-purple-500/20"
                        >
                          {loc}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">Default (~/.omniroute/)</span>
                    )}
                  </div>
                </div>

                {/* On-Demand Trigger Action Bar */}
                <div className="pt-4 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center space-x-3">
                    <button
                      onClick={handleCalculateAnalytics}
                      disabled={calculatingAnalytics}
                      className="px-4 py-2 text-xs font-semibold rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white shadow-md transition-all flex items-center space-x-2 disabled:opacity-50"
                    >
                      <span>⚡</span>
                      <span>
                        {calculatingAnalytics
                          ? "Calculating..."
                          : analytics
                            ? "Refresh Analytics"
                            : "Calculate Analytics"}
                      </span>
                    </button>

                    <button
                      onClick={handleGenerateBrief}
                      disabled={generatingBrief}
                      className="px-4 py-2 text-xs font-semibold rounded-xl bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-500 hover:to-purple-600 text-white shadow-md transition-all flex items-center space-x-2 disabled:opacity-50"
                    >
                      <span>✨</span>
                      <span>
                        {generatingBrief
                          ? "Generating..."
                          : brief
                            ? "Update Brief More"
                            : "Get Deep Brief"}
                      </span>
                    </button>
                  </div>

                  <div className="text-xs text-slate-400">
                    {analytics?.lastComputedAt ? (
                      <span>
                        Calculated {new Date(analytics.lastComputedAt * 1000).toLocaleTimeString()}
                      </span>
                    ) : (
                      <span className="italic text-slate-500">On-demand calculation ready</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Token Economics Section */}
              {analytics && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
                      📊 Token Economics & Consumption
                    </h3>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-emerald-400">Success</span>
                      <div className="text-lg font-bold text-slate-100">
                        {analytics.tokenEconomics.success.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-slate-500">2xx responses</span>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-amber-400">Wasted</span>
                      <div className="text-lg font-bold text-slate-100">
                        {analytics.tokenEconomics.wasted.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-slate-500">Failed / retries</span>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-purple-400">Cache Hits</span>
                      <div className="text-lg font-bold text-slate-100">
                        {analytics.tokenEconomics.cached.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-slate-500">Prefix hits</span>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-blue-400">Saved</span>
                      <div className="text-lg font-bold text-slate-100">
                        {analytics.tokenEconomics.saved.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-slate-500">Combo routed</span>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-sky-400">Sessions</span>
                      <div className="text-lg font-bold text-slate-100">
                        {analytics.sessions.total}
                      </div>
                      <span className="text-[10px] text-slate-500">Total sessions</span>
                    </div>

                    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5 space-y-1">
                      <span className="text-[11px] font-medium text-emerald-400">USD Cost</span>
                      <div className="text-lg font-bold text-emerald-300">
                        ${analytics.tokenEconomics.costUsd.toFixed(3)}
                      </div>
                      <span className="text-[10px] text-slate-500">Ledger spend</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Models & Prompts Breakdown */}
              {analytics && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Models Breakdown */}
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center space-x-1.5">
                      <span>🤖</span>
                      <span>Models & Agents Used</span>
                    </h4>

                    {Object.keys(analytics.agents.models?.byModel ?? {}).length > 0 ? (
                      <div className="space-y-2">
                        {Object.entries(analytics.agents.models!.byModel!).map(([model, count]) => {
                          const total = analytics.agents.models?.total || 1;
                          const pct = Math.round((count / total) * 100);
                          return (
                            <div key={model} className="space-y-1">
                              <div className="flex justify-between text-xs text-slate-300">
                                <span className="font-mono text-[11px] truncate">{model}</span>
                                <span className="text-slate-400 font-semibold">
                                  {count} ({pct}%)
                                </span>
                              </div>
                              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-indigo-500 rounded-full"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 py-3">No model calls recorded yet</div>
                    )}

                    {analytics.agents.combos && analytics.agents.combos.length > 0 && (
                      <div className="pt-3 border-t border-slate-800/80">
                        <span className="text-[11px] text-slate-400 font-medium">Combos: </span>
                        <span className="text-xs text-indigo-400 font-medium">
                          {analytics.agents.combos.join(", ")}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Prompt Histories */}
                  <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center space-x-1.5">
                        <span>💬</span>
                        <span>User Entered Prompt History</span>
                      </h4>
                      <span className="text-[11px] text-slate-400">
                        {analytics.sessions.uniquePrompts} unique
                      </span>
                    </div>

                    {analytics.sessions.recentPrompts &&
                    analytics.sessions.recentPrompts.length > 0 ? (
                      <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                        {analytics.sessions.recentPrompts.map((p, idx) => (
                          <div
                            key={idx}
                            className="bg-slate-800/50 rounded-xl p-2.5 text-xs text-slate-300 border border-slate-800"
                          >
                            <p className="line-clamp-2 leading-relaxed">{p.prompt}</p>
                            <span className="text-[10px] text-slate-500 mt-1 block">
                              {new Date(p.timestamp).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500 py-3">
                        No user prompts recorded yet
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Optimization Suggestions */}
              {analytics?.optimizations && analytics.optimizations.length > 0 && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-400 flex items-center space-x-1.5">
                    <span>💡</span>
                    <span>Suggestions for Optimization</span>
                  </h4>
                  <div className="space-y-2">
                    {analytics.optimizations.map((opt, idx) => (
                      <div
                        key={idx}
                        className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-200/90 flex items-start space-x-2.5"
                      >
                        <span className="text-amber-400 font-bold">•</span>
                        <p className="leading-relaxed">{opt}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Deep Brief Output */}
              {brief && (
                <div className="bg-gradient-to-br from-purple-950/20 to-slate-900/80 border border-purple-800/30 rounded-2xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-purple-300 flex items-center space-x-2">
                      <span>✨</span>
                      <span>Executive Project Brief</span>
                    </h4>
                    <span className="text-[11px] text-purple-400/80">
                      Generated {new Date(brief.generatedAt * 1000).toLocaleString()}
                    </span>
                  </div>

                  <p className="text-sm text-slate-200 leading-relaxed bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                    {brief.summary}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">
                        Key Optimizations
                      </span>
                      <ul className="space-y-1.5 text-xs text-slate-300">
                        {brief.optimizations.map((opt, idx) => (
                          <li key={idx} className="flex items-start space-x-2">
                            <span className="text-purple-400">✓</span>
                            <span>{opt}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="space-y-2">
                      <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider">
                        Recommendations
                      </span>
                      <ul className="space-y-1.5 text-xs text-slate-300">
                        {brief.recommendations.map((rec, idx) => (
                          <li key={idx} className="flex items-start space-x-2">
                            <span className="text-purple-400">→</span>
                            <span>{rec}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center text-slate-500">
              Select or register a project to view its intelligence dashboard.
            </div>
          )}
        </div>
      </div>

      {/* Register Project Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-slate-100">Connect New Workspace Project</h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRegisterProject} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Absolute Base Path <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="/Users/username/work/my-project"
                  value={newBasePath}
                  onChange={(e) => setNewBasePath(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Project Name (Optional, auto-detected from directory)
                </label>
                <input
                  type="text"
                  placeholder="My AI App"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Description (Optional)
                </label>
                <textarea
                  rows={2}
                  placeholder="Project purpose and architecture notes..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div className="pt-2 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  Connect & Scan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Details Modal */}
      {showEditModal && selectedProject && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-bold text-slate-100">Edit Project Details</h3>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Tech Stack (comma-separated)
                </label>
                <input
                  type="text"
                  value={editTechStack}
                  onChange={(e) => setEditTechStack(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Cloud Stack (comma-separated)
                </label>
                <input
                  type="text"
                  value={editCloudStack}
                  onChange={(e) => setEditCloudStack(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Features (comma-separated)
                </label>
                <input
                  type="text"
                  value={editFeatures}
                  onChange={(e) => setEditFeatures(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Memory Locations (comma-separated absolute paths)
                </label>
                <input
                  type="text"
                  value={editMemoryLocations}
                  onChange={(e) => setEditMemoryLocations(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="pt-2 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-xs font-medium rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
