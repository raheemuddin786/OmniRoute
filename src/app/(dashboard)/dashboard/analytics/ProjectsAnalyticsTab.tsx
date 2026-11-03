"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { ProjectRegistry, ProjectAnalytics, ProjectBrief } from "@/lib/db/projectRegistry";
import { matchesSearch } from "@/shared/utils/turkishText";
import { fmtCompact } from "@/shared/utils/formatting";
import { PromptAnalyticsTab } from "./tabs/PromptAnalyticsTab";

export function ProjectsAnalyticsTab() {
  const [projects, setProjects] = useState<ProjectRegistry[]>([]);
  // selectedProjectId: null or "__global__" means Global Application Overview
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [globalAnalytics, setGlobalAnalytics] = useState<ProjectAnalytics | null>(null);
  const [globalBrief, setGlobalBrief] = useState<ProjectBrief | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [calculatingAnalytics, setCalculatingAnalytics] = useState<boolean>(false);
  const [generatingBrief, setGeneratingBrief] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortBy, setSortBy] = useState<"name" | "files" | "tokens" | "updated">("updated");
  const [filterProvenance, setFilterProvenance] = useState<"all" | "derived" | "manual">("all");
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // View modes: "overview" (metrics/models/brief) vs "prompts" (interactive prompt analytics)
  const [projectViewMode, setProjectViewMode] = useState<"overview" | "prompts">("overview");

  // Archive/filter states
  const [showArchived, setShowArchived] = useState<boolean>(false);

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

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/projects");
      const data = await res.json();
      if (data.success && Array.isArray(data.projects)) {
        setProjects(data.projects);
      } else {
        showNotice("error", "Failed to fetch connected projects");
      }
    } catch {
      showNotice("error", "Network error loading projects");
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    let ignore = false;
    async function init() {
      try {
        const res = await fetch("/api/v1/projects");
        const data = await res.json();
        if (!ignore && data.success && Array.isArray(data.projects)) {
          setProjects(data.projects);
        }
      } catch {
        if (!ignore) showNotice("error", "Failed to fetch connected projects");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    void init();
    return () => {
      ignore = true;
    };
  }, [showNotice]);

  const isGlobalView = !selectedProjectId || selectedProjectId === "__global__";
  const selectedProject = useMemo(() => {
    if (isGlobalView) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [isGlobalView, projects, selectedProjectId]);

  // Filtered and sorted projects
  const filteredProjects = useMemo(() => {
    // Separate by archive status: "archiving" status represents archived projects
    let list = projects.filter((p) => {
      const isArchived = p.status === "archiving";
      return showArchived ? isArchived : !isArchived;
    });

    if (searchQuery.trim()) {
      const q = searchQuery.trim();
      list = list.filter(
        (p) =>
          matchesSearch(p.name, q) ||
          matchesSearch(p.basePath, q) ||
          matchesSearch(p.description, q) ||
          (p.techStack && p.techStack.some((t) => matchesSearch(t, q)))
      );
    }

    if (filterProvenance !== "all") {
      list = list.filter((p) => (p.provenance || "derived") === filterProvenance);
    }

    list.sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === "files") {
        return (b.filesCount ?? 0) - (a.filesCount ?? 0);
      }
      if (sortBy === "tokens") {
        const aTokens =
          (a.analyticsCache?.tokenEconomics.success ?? 0) +
          (a.analyticsCache?.tokenEconomics.cached ?? 0);
        const bTokens =
          (b.analyticsCache?.tokenEconomics.success ?? 0) +
          (b.analyticsCache?.tokenEconomics.cached ?? 0);
        return bTokens - aTokens;
      }
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    return list;
  }, [projects, showArchived, searchQuery, filterProvenance, sortBy]);

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
    setCalculatingAnalytics(true);
    const targetId = isGlobalView ? "__global__" : selectedProject?.id;
    if (!targetId) return;

    try {
      const res = await fetch(`/api/v1/projects/${targetId}/analytics`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success && data.analytics) {
        if (isGlobalView) {
          setGlobalAnalytics(data.analytics);
        } else {
          setProjects((prev) =>
            prev.map((p) =>
              p.id === targetId
                ? {
                    ...p,
                    analyticsCache: data.analytics,
                    analyticsCachedAt: data.analytics.lastComputedAt,
                  }
                : p
            )
          );
        }
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
    setGeneratingBrief(true);
    const targetId = isGlobalView ? "__global__" : selectedProject?.id;
    if (!targetId) return;

    try {
      const res = await fetch(`/api/v1/projects/${targetId}/brief`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success && data.brief) {
        if (isGlobalView) {
          setGlobalBrief(data.brief);
        } else {
          setProjects((prev) =>
            prev.map((p) =>
              p.id === targetId
                ? {
                    ...p,
                    briefCache: data.brief,
                    briefGeneratedAt: data.brief.generatedAt,
                  }
                : p
            )
          );
        }
        showNotice("success", "Executive brief generated successfully");
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
    if (!newBasePath.trim()) {
      showNotice("error", "Please provide a valid directory path to scan");
      return;
    }
    setScanning(true);
    try {
      const res = await fetch("/api/v1/projects/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basePath: newBasePath.trim() }),
      });
      const data = await res.json();
      if (data.success && data.scan) {
        setNewName(data.scan.name);
        setNewDescription(data.scan.description);
        showNotice(
          "info",
          `Auto-discovered: ${data.scan.name} (${data.scan.filesCount} files, ${data.scan.docsCount} docs)`
        );
      } else {
        showNotice("error", data.error || "Failed to scan directory");
      }
    } catch {
      showNotice("error", "Directory scanning request failed");
    } finally {
      setScanning(false);
    }
  };

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBasePath.trim()) {
      showNotice("error", "Directory path is required");
      return;
    }
    try {
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          basePath: newBasePath.trim(),
          name: newName.trim() || undefined,
          description: newDescription.trim() || undefined,
          provenance: "manual",
        }),
      });
      const data = await res.json();
      if (data.success && data.project) {
        showNotice("success", `Workspace "${data.project.name}" registered successfully`);
        setShowAddModal(false);
        setNewBasePath("");
        setNewName("");
        setNewDescription("");
        await loadProjects();
        setSelectedProjectId(data.project.id);
      } else {
        showNotice("error", data.error || "Failed to register project");
      }
    } catch {
      showNotice("error", "Network error registering project");
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject) return;

    const patch: Partial<ProjectRegistry> = {
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
    };

    try {
      const res = await fetch(`/api/v1/projects/${selectedProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.success && data.project) {
        setProjects((prev) => prev.map((p) => (p.id === selectedProject.id ? data.project : p)));
        showNotice("success", "Project metadata updated");
        setShowEditModal(false);
      } else {
        showNotice("error", data.error || "Failed to update project metadata");
      }
    } catch {
      showNotice("error", "Failed to update project metadata");
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (
      !confirm(
        "Are you sure you want to remove this project? This will only remove registry metadata."
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/v1/projects/${projectId}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showNotice("success", "Project removed from registry");
        if (selectedProjectId === projectId) {
          setSelectedProjectId(null);
        }
        await loadProjects();
      } else {
        showNotice("error", data.error || "Failed to remove project");
      }
    } catch {
      showNotice("error", "Failed to delete project");
    }
  };

  const handleArchiveProject = async (projectId: string, archive: boolean) => {
    const project = projects.find((p) => p.id === projectId);
    const label = archive ? "archive" : "restore";
    if (
      !confirm(
        archive
          ? `Archive "${project?.name ?? projectId}"? It will be hidden from the active list but its call-log linkage and analytics cache are preserved.`
          : `Restore "${project?.name ?? projectId}" back to the active list?`
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/v1/projects/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: archive ? "archive" : "reactivate" }),
      });
      const data = await res.json();
      if (data.success && data.project) {
        showNotice("success", archive ? "Project archived" : "Project restored to active");
        setProjects((prev) => prev.map((p) => (p.id === projectId ? data.project : p)));
      } else {
        showNotice("error", data.error || `Failed to ${label} project`);
      }
    } catch {
      showNotice("error", `Failed to ${label} project`);
    }
  };

  const handleRefreshProjects = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/v1/projects/refresh", { method: "POST" });
      const data = await res.json();
      if (data.success && Array.isArray(data.projects)) {
        setProjects(data.projects);
        showNotice(
          "success",
          `Workspace discovery complete — ${data.total} project(s) tracked, ${data.backfilled ?? 0} call-log rows backfilled`
        );
      } else {
        showNotice("error", data.error || "Failed to refresh workspaces");
      }
    } catch {
      showNotice("error", "Failed to refresh workspaces");
    } finally {
      setScanning(false);
    }
  };

  // Determine active analytics & brief to show
  const activeAnalytics: ProjectAnalytics | null = isGlobalView
    ? globalAnalytics
    : (selectedProject?.analyticsCache ?? null);

  const activeBrief: ProjectBrief | null = isGlobalView
    ? globalBrief
    : (selectedProject?.briefCache ?? null);

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
                <h3 className="font-semibold text-slate-100">Workspaces & Projects</h3>
              </div>
              <div className="flex items-center space-x-1.5">
                <button
                  onClick={handleRefreshProjects}
                  disabled={scanning}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 hover:text-white transition-colors border border-slate-700/80 flex items-center justify-center"
                  title="Refresh / auto-discover workspaces and sync project linkages"
                  aria-label="Refresh workspaces"
                >
                  <span className={`inline-block text-xs ${scanning ? "animate-spin" : ""}`}>
                    🔄
                  </span>
                </button>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center space-x-1"
                  title="Add manual project directory"
                >
                  <span>+</span>
                  <span>Manual</span>
                </button>
              </div>
            </div>

            {/* Global Application View Option */}
            <div className="mb-4">
              <button
                onClick={() => setSelectedProjectId("__global__")}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-center justify-between ${
                  isGlobalView
                    ? "bg-indigo-950/40 border-indigo-500/50 shadow-sm"
                    : "bg-slate-950/40 border-slate-800/60 hover:border-slate-700/80 hover:bg-slate-800/40"
                }`}
              >
                <div className="flex items-center space-x-3 min-w-0">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${
                      isGlobalView ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300"
                    }`}
                  >
                    🌐
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold text-slate-100 text-sm truncate">
                        Global Application
                      </span>
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                        Aggregated
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 truncate mt-0.5">
                      All proxy routes, sessions & workspaces
                    </p>
                  </div>
                </div>
                <span className="text-xs text-slate-500 font-mono shrink-0 ml-2">
                  {projects.filter((p) => p.status !== "archiving").length} active
                </span>
              </button>
            </div>

            {/* Active vs Archived Sub-tabs */}
            <div className="flex border-b border-slate-800/80 mb-3 text-xs">
              <button
                type="button"
                onClick={() => setShowArchived(false)}
                className={`flex-1 py-1.5 px-3 text-center font-medium border-b-2 transition-colors flex items-center justify-center space-x-1.5 ${
                  !showArchived
                    ? "border-indigo-500 text-indigo-400 bg-indigo-500/5"
                    : "border-transparent text-slate-400 hover:text-slate-300"
                }`}
              >
                <span>Active</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-800 text-slate-400 font-mono">
                  {projects.filter((p) => p.status !== "archiving").length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setShowArchived(true)}
                className={`flex-1 py-1.5 px-3 text-center font-medium border-b-2 transition-colors flex items-center justify-center space-x-1.5 ${
                  showArchived
                    ? "border-amber-500 text-amber-400 bg-amber-500/5"
                    : "border-transparent text-slate-400 hover:text-slate-300"
                }`}
              >
                <span>Archived</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-800 text-slate-400 font-mono">
                  {projects.filter((p) => p.status === "archiving").length}
                </span>
              </button>
            </div>

            {/* Search, Filter & Sort Controls */}
            <div className="space-y-2 mb-3">
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500 text-xs">
                  🔍
                </span>
                <input
                  type="text"
                  placeholder="Filter by name, path, tech..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-slate-950/80 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-500 hover:text-slate-300 text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400 gap-1.5">
                <div className="flex items-center space-x-1">
                  <span className="text-slate-500">Source:</span>
                  <select
                    value={filterProvenance}
                    onChange={(e) =>
                      setFilterProvenance(e.target.value as "all" | "derived" | "manual")
                    }
                    className="bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-[11px] focus:outline-none focus:border-indigo-500"
                  >
                    <option value="all">All</option>
                    <option value="derived">Auto-Derived</option>
                    <option value="manual">Manual</option>
                  </select>
                </div>

                <div className="flex items-center space-x-1">
                  <span className="text-slate-500">Sort:</span>
                  <select
                    value={sortBy}
                    onChange={(e) =>
                      setSortBy(e.target.value as "name" | "files" | "tokens" | "updated")
                    }
                    className="bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-300 text-[11px] focus:outline-none focus:border-indigo-500"
                  >
                    <option value="updated">Recent</option>
                    <option value="tokens">Token Spend</option>
                    <option value="files">Files Count</option>
                    <option value="name">Name</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Tree / Project List */}
            {loading ? (
              <div className="py-12 text-center text-slate-500 text-sm animate-pulse">
                Discovering workspaces & routing corpuses...
              </div>
            ) : filteredProjects.length === 0 ? (
              <div className="py-8 text-center text-slate-500 text-sm">
                No matching projects found.
              </div>
            ) : (
              <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                {filteredProjects.map((p) => {
                  const isSelected = selectedProject?.id === p.id;
                  const isAuto = (p.provenance || "derived") === "derived";
                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedProjectId(p.id)}
                      className={`p-3 rounded-xl border cursor-pointer transition-all ${
                        isSelected
                          ? "bg-slate-850 dark:bg-slate-800/90 border-indigo-500/60 shadow-sm"
                          : "bg-slate-950/40 border-slate-800/60 hover:border-slate-700/80 hover:bg-slate-800/40"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 pr-2">
                          <div className="flex items-center space-x-2">
                            <span className="font-semibold text-slate-100 text-sm truncate">
                              {p.name}
                            </span>
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] font-mono border ${
                                isAuto
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                              }`}
                            >
                              {isAuto ? "auto-derived" : "manual"}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 font-mono truncate mt-0.5">
                            {p.basePath}
                          </p>
                        </div>
                        <span
                          className="text-[11px] text-slate-500 font-mono shrink-0"
                          title={`${p.filesCount} files tracked`}
                        >
                          {fmtCompact(p.filesCount)} files
                        </span>
                      </div>

                      {/* Tech stack badges preview */}
                      {p.techStack && p.techStack.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {p.techStack.slice(0, 3).map((tech) => (
                            <span
                              key={tech}
                              className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-800 text-slate-300"
                            >
                              {tech}
                            </span>
                          ))}
                          {p.techStack.length > 3 && (
                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800/60 text-slate-500">
                              +{p.techStack.length - 3}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Per-project actions: archive / delete */}
                      <div className="flex items-center justify-end gap-1.5 mt-2 pt-2 border-t border-slate-800/60">
                        {p.status !== "archiving" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleArchiveProject(p.id, true);
                            }}
                            className="px-2 py-1 text-[10px] font-medium rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 transition-colors"
                            title="Archive project (preserves linkage & analytics cache)"
                          >
                            Archive
                          </button>
                        )}
                        {p.status === "archiving" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleArchiveProject(p.id, false);
                            }}
                            className="px-2 py-1 text-[10px] font-medium rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-colors"
                            title="Restore project to active"
                          >
                            Restore
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteProject(p.id);
                          }}
                          className="px-2 py-1 text-[10px] font-medium rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-colors"
                          title="Remove project from registry"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel: Project Details & On-Demand Analytics (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Header Card: Project Identity / Global Overview */}
          <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
              <div>
                <div className="flex items-center space-x-3">
                  <h2 className="text-xl font-bold text-slate-100">
                    {isGlobalView ? "Global Application Overview" : selectedProject?.name}
                  </h2>
                  <span
                    className={`px-2 py-0.5 text-xs font-semibold rounded-full border ${
                      isGlobalView
                        ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/30"
                        : selectedProject?.status === "active"
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                          : "bg-slate-800 text-slate-400 border-slate-700"
                    }`}
                  >
                    {isGlobalView ? "Aggregated Proxy Mesh" : (selectedProject?.status ?? "active")}
                  </span>
                </div>
                <p className="text-xs text-slate-400 font-mono mt-1 break-all">
                  {isGlobalView
                    ? "Observability and token economics aggregated across all proxy routing requests"
                    : selectedProject?.basePath}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* View Mode Switcher - Available in both Global and Project Scopes */}
                <div className="flex items-center space-x-1 bg-slate-950/60 rounded-lg border border-slate-700 p-0.5">
                  <button
                    onClick={() => setProjectViewMode("overview")}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 ${
                      projectViewMode === "overview"
                        ? "bg-slate-800 text-slate-200 shadow-sm"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"
                    }`}
                  >
                    Overview
                  </button>
                  <button
                    onClick={() => setProjectViewMode("prompts")}
                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 ${
                      projectViewMode === "prompts"
                        ? "bg-slate-800 text-slate-200 shadow-sm"
                        : "text-slate-400 hover:text-slate-200 hover:bg-slate-900/60"
                    }`}
                  >
                    Prompt Analytics
                  </button>
                </div>

                {!isGlobalView && selectedProject && (
                  <>
                    <button
                      onClick={handleOpenEditModal}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors border border-slate-700"
                    >
                      Edit Metadata
                    </button>
                    {selectedProject.status !== "archiving" ? (
                      <button
                        onClick={() => void handleArchiveProject(selectedProject.id, true)}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 transition-colors border border-amber-500/30"
                        title="Archive project (keeps call logs and analytics cache)"
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleArchiveProject(selectedProject.id, false)}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors border border-emerald-500/30"
                        title="Restore project to active"
                      >
                        Restore
                      </button>
                    )}
                    <button
                      onClick={() => void handleDeleteProject(selectedProject.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-colors border border-rose-500/30"
                      title="Delete project from registry"
                    >
                      Delete
                    </button>
                  </>
                )}
                <button
                  onClick={handleCalculateAnalytics}
                  disabled={calculatingAnalytics}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors flex items-center space-x-1.5 shadow-sm"
                >
                  <span>{calculatingAnalytics ? "⚡" : "📊"}</span>
                  <span>
                    {calculatingAnalytics
                      ? "Calculating..."
                      : activeAnalytics
                        ? "Refresh Analytics"
                        : "Calculate Analytics"}
                  </span>
                </button>
                <button
                  onClick={handleGenerateBrief}
                  disabled={generatingBrief}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors flex items-center space-x-1.5 shadow-sm"
                >
                  <span>{generatingBrief ? "⏳" : "✨"}</span>
                  <span>
                    {generatingBrief
                      ? "Generating..."
                      : activeBrief
                        ? "Update Brief More"
                        : "Generate Executive Brief"}
                  </span>
                </button>
              </div>
            </div>

            {/* Static Metadata Cards */}
            {!isGlobalView && selectedProject && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4 pt-2">
                <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    Files Tracked
                  </span>
                  <div
                    className="text-lg font-bold text-slate-100 mt-1"
                    title={`${selectedProject.filesCount ?? 0} files tracked`}
                  >
                    {fmtCompact(selectedProject.filesCount ?? 0)}
                  </div>
                </div>
                <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    Docs & Corpuses
                  </span>
                  <div
                    className="text-lg font-bold text-slate-100 mt-1"
                    title={`${selectedProject.docsCount ?? 0} documents`}
                  >
                    {fmtCompact(selectedProject.docsCount ?? 0)}
                  </div>
                </div>
                <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    RAG / Index Status
                  </span>
                  <div className="text-sm font-semibold text-emerald-400 mt-1.5 flex items-center space-x-1">
                    <span>●</span>
                    <span className="capitalize">{selectedProject.ragStatus ?? "healthy"}</span>
                  </div>
                </div>
                <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/60">
                  <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                    Provenance
                  </span>
                  <div className="text-sm font-semibold text-slate-200 mt-1.5 capitalize">
                    {selectedProject.provenance ?? "derived"}
                  </div>
                </div>
              </div>
            )}

            {/* Tech Stack & Stacks */}
            {!isGlobalView && selectedProject && (
              <div className="mt-4 pt-4 border-t border-slate-800/60 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-slate-400 font-medium block mb-1.5">Tech Stack:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProject.techStack && selectedProject.techStack.length > 0 ? (
                      selectedProject.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]"
                        >
                          {tech}
                        </span>
                      ))
                    ) : (
                      <span className="text-slate-500">None detected</span>
                    )}
                  </div>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block mb-1.5">Cloud Stack:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProject.cloudStack && selectedProject.cloudStack.length > 0 ? (
                      selectedProject.cloudStack.map((cloud) => (
                        <span
                          key={cloud}
                          className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]"
                        >
                          {cloud}
                        </span>
                      ))
                    ) : (
                      <span className="text-slate-500">None detected</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Conditional View: Prompts Analytics vs Standard Overview */}
          {projectViewMode === "prompts" ? (
            <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <span className="text-lg">💬</span>
                  <h3 className="font-semibold text-slate-100">
                    Comprehensive Prompt Analytics & Session History
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setProjectViewMode("overview")}
                  className="px-3 py-1 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                >
                  ← Back to Overview
                </button>
              </div>

              <PromptAnalyticsTab
                recentPrompts={activeAnalytics?.sessions?.recentPrompts ?? []}
                tokensInSuccess={activeAnalytics?.tokenEconomics?.success ?? 0}
                tokensOutSuccess={activeAnalytics?.tokenEconomics?.success ?? 0}
                tokenEconomics={activeAnalytics?.tokenEconomics}
                selectedProjectId={isGlobalView ? "Global Application" : selectedProject?.name}
                onRefresh={handleCalculateAnalytics}
                calculating={calculatingAnalytics}
              />
            </div>
          ) : (
            <>
              {/* Token Economics Section (6 Key Dimensions) */}
              <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center space-x-2">
                    <span className="text-lg">💎</span>
                    <h3 className="font-semibold text-slate-100">
                      {isGlobalView
                        ? "Global Token Economics & Consumption"
                        : "Project Token Economics & Consumption"}
                    </h3>
                  </div>
                  {activeAnalytics ? (
                    <span className="text-xs text-slate-500 font-mono">
                      Computed:{" "}
                      {new Date(activeAnalytics.lastComputedAt * 1000).toLocaleTimeString()}
                    </span>
                  ) : (
                    <span className="text-xs text-amber-400/90 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      On-Demand (Click Calculate to Load)
                    </span>
                  )}
                </div>

                {activeAnalytics ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {/* 1. Success Tokens */}
                    <div className="bg-slate-950/60 p-3.5 rounded-xl border border-emerald-500/20">
                      <span className="text-[11px] text-emerald-400 font-medium uppercase tracking-wider block">
                        Success
                      </span>
                      <div
                        className="text-base font-bold text-slate-100 mt-1 font-mono"
                        title={`${activeAnalytics.tokenEconomics.success.toLocaleString()} tokens`}
                      >
                        {fmtCompact(activeAnalytics.tokenEconomics.success)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">2xx responses</span>
                    </div>

                    {/* 2. Wasted Tokens */}
                    <div className="bg-slate-950/60 p-3.5 rounded-xl border border-rose-500/20">
                      <span className="text-[11px] text-rose-400 font-medium uppercase tracking-wider block">
                        Wasted
                      </span>
                      <div
                        className="text-base font-bold text-slate-100 mt-1 font-mono"
                        title={`${activeAnalytics.tokenEconomics.wasted.toLocaleString()} tokens`}
                      >
                        {fmtCompact(activeAnalytics.tokenEconomics.wasted)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        Errors / Aborts
                      </span>
                    </div>

                    {/* 3. Cache Hits */}
                    <div className="bg-slate-950/60 p-3.5 rounded-xl border border-blue-500/20">
                      <span className="text-[11px] text-blue-400 font-medium uppercase tracking-wider block">
                        Cache Hits
                      </span>
                      <div
                        className="text-base font-bold text-slate-100 mt-1 font-mono"
                        title={`${activeAnalytics.tokenEconomics.cached.toLocaleString()} tokens`}
                      >
                        {fmtCompact(activeAnalytics.tokenEconomics.cached)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        Prompt cache reads
                      </span>
                    </div>

                    {/* 4. Saved Tokens */}
                    <div className="bg-slate-950/60 p-3.5 rounded-xl border border-indigo-500/20">
                      <span className="text-[11px] text-indigo-400 font-medium uppercase tracking-wider block">
                        Saved Tokens
                      </span>
                      <div
                        className="text-base font-bold text-slate-100 mt-1 font-mono"
                        title={`${activeAnalytics.tokenEconomics.saved.toLocaleString()} tokens`}
                      >
                        {fmtCompact(activeAnalytics.tokenEconomics.saved)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        Combo & Caching
                      </span>
                    </div>

                    {/* 5. Pricing / USD */}
                    <div className="bg-slate-950/60 p-3.5 rounded-xl border border-amber-500/20">
                      <span className="text-[11px] text-amber-400 font-medium uppercase tracking-wider block">
                        Pricing (USD)
                      </span>
                      <div className="text-base font-bold text-slate-100 mt-1 font-mono">
                        ${activeAnalytics.tokenEconomics.costUsd.toFixed(4)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">Ledger cost</span>
                    </div>

                    {/* 6. Unique Prompts */}
                    <div
                      onClick={() => setProjectViewMode("prompts")}
                      className="bg-slate-950/60 p-3.5 rounded-xl border border-purple-500/20 hover:border-purple-500/50 hover:bg-slate-950/80 cursor-pointer transition-all duration-200 group"
                      title="Click to view detailed prompt analytics and session history"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-purple-400 font-medium uppercase tracking-wider block">
                          Unique Prompts
                        </span>
                        <span className="text-[10px] text-purple-400/70 group-hover:text-purple-300 transition-colors">
                          View ↗
                        </span>
                      </div>
                      <div
                        className="text-base font-bold text-slate-100 mt-1 font-mono group-hover:text-purple-200 transition-colors"
                        title={`${activeAnalytics.sessions.uniquePrompts.toLocaleString()} unique prompts`}
                      >
                        {fmtCompact(activeAnalytics.sessions.uniquePrompts)}
                      </div>
                      <span className="text-[10px] text-slate-500 block mt-0.5">
                        Distinct queries
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center bg-slate-950/30 rounded-xl border border-slate-800/40">
                    <p className="text-xs text-slate-400">
                      Token analytics are computed on-demand to maintain zero overhead on inference.
                    </p>
                    <button
                      onClick={handleCalculateAnalytics}
                      className="mt-3 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                    >
                      ⚡ Run On-Demand Analytics
                    </button>
                  </div>
                )}
              </div>

              {/* Model Distribution & Agents/Combos breakdown */}
              {activeAnalytics && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Models used */}
                  <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-sm">
                    <h4 className="text-sm font-semibold text-slate-200 mb-3 flex items-center space-x-2">
                      <span>🤖</span>
                      <span>Models Distribution</span>
                    </h4>
                    {activeAnalytics.agents.models?.byModel &&
                    Object.keys(activeAnalytics.agents.models.byModel).length > 0 ? (
                      <div className="space-y-2">
                        {Object.entries(activeAnalytics.agents.models.byModel).map(
                          ([model, count]) => (
                            <div key={model} className="flex items-center justify-between text-xs">
                              <span className="font-mono text-slate-300 truncate pr-2">
                                {model}
                              </span>
                              <span className="font-mono text-slate-500">{count} calls</span>
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">No model calls recorded yet.</p>
                    )}
                  </div>

                  {/* Combos & Agents */}
                  <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-sm">
                    <h4 className="text-sm font-semibold text-slate-200 mb-3 flex items-center space-x-2">
                      <span>⚡</span>
                      <span>Agents & Routing Combos</span>
                    </h4>
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Total Skills Enabled:</span>
                        <span className="font-mono text-slate-200">
                          {activeAnalytics.agents.skills.total}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">MCP Server Tools:</span>
                        <span className="font-mono text-slate-200">
                          {activeAnalytics.agents.mcpTools ?? 110}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Active Combos:</span>
                        <span className="font-mono text-slate-200">
                          {(activeAnalytics.agents.combos ?? []).join(", ") || "Auto-Combo"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Executive Brief & Optimization Suggestions */}
              {activeBrief && (
                <div className="bg-slate-900/60 dark:bg-slate-900/80 border border-indigo-500/30 rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                    <div className="flex items-center space-x-2">
                      <span className="text-lg">✨</span>
                      <h3 className="font-semibold text-slate-100">
                        Executive Brief & Optimization
                      </h3>
                    </div>
                    <span className="text-xs text-slate-500 font-mono">
                      Generated: {new Date(activeBrief.generatedAt * 1000).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed">{activeBrief.summary}</p>

                  {activeBrief.optimizations && activeBrief.optimizations.length > 0 && (
                    <div className="pt-2">
                      <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider block mb-2">
                        Optimization Insights:
                      </span>
                      <ul className="list-disc list-inside space-y-1 text-xs text-slate-300">
                        {activeBrief.optimizations.map((opt, idx) => (
                          <li key={idx}>{opt}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Add Workspace Modal (Manual Fallback) */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-100 mb-4">Register Manual Workspace</h3>
            <form onSubmit={handleAddProject} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Directory Path
                </label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    required
                    placeholder="/path/to/project"
                    value={newBasePath}
                    onChange={(e) => setNewBasePath(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={handleScanDirectory}
                    disabled={scanning}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-slate-200 rounded-lg hover:bg-slate-700"
                  >
                    {scanning ? "..." : "Scan"}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  placeholder="My App"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-500"
                >
                  Register Workspace
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Workspace Modal */}
      {showEditModal && selectedProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-100 mb-4">Edit Workspace Metadata</h3>
            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Tech Stack (comma-separated)
                </label>
                <input
                  type="text"
                  value={editTechStack}
                  onChange={(e) => setEditTechStack(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Cloud Stack (comma-separated)
                </label>
                <input
                  type="text"
                  value={editCloudStack}
                  onChange={(e) => setEditCloudStack(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
                />
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => handleDeleteProject(selectedProject.id)}
                  className="text-xs text-rose-400 hover:text-rose-300"
                >
                  Delete Project
                </button>
                <div className="flex space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowEditModal(false)}
                    className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-500"
                  >
                    Save Changes
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
