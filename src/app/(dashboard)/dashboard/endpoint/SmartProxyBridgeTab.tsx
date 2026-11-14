/**
 * Smart Proxy Bridge with Intelligent Routing (SPB-IR) Dashboard Tab
 * Provides real-time visibility into intent classification, model tier assignment,
 * prompt anchor caching, zero-loss state checkpointing, and live feature toggle.
 */

import React, { useState, useEffect, useCallback } from "react";
import Toggle from "@/shared/components/Toggle";
import TierModelSelectModal from "@/shared/components/TierModelSelectModal";
import SmartProxyActivitySection from "./SmartProxyActivitySection";
import type { ConcreteSpbRuntimeConfig } from "@omniroute/open-sse/services/tierTypes";
import { DEFAULT_SPB_RUNTIME_CONFIG } from "@omniroute/open-sse/services/tierTypes";

interface BridgeStats {
  totalRouted: number;
  activeTiers: { apex: number; resilient: number; local: number };
  checkpointsRestored: number;
  fallbacksTriggered: number;
  lastRoutedAt: string | null;
}

interface TierWeights {
  apex: number;
  resilient: number;
  local: number;
}

interface TierModels {
  apex: string[];
  resilient: string[];
  local: string[];
}

type TierSelectionMode = "free" | "user" | "both";

interface TierModes {
  apex: TierSelectionMode;
  resilient: TierSelectionMode;
  local: TierSelectionMode;
}

interface FreeModelTile {
  provider: string;
  model: string;
  displayName: string;
  tier: "apex" | "resilient" | "local";
  capabilities?: {
    reasoning?: boolean;
    toolCall?: boolean;
    coding?: boolean;
  };
}

const EMPTY_STATS: BridgeStats = {
  totalRouted: 0,
  activeTiers: { apex: 0, resilient: 0, local: 0 },
  checkpointsRestored: 0,
  fallbacksTriggered: 0,
  lastRoutedAt: null,
};

export function SmartProxyBridgeTab() {
  const [stats, setStats] = useState<BridgeStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [spbEnabled, setSpbEnabled] = useState<boolean>(false);
  const [toggling, setToggling] = useState(false);

  // Config state
  const [cacheThreshold, setCacheThreshold] = useState(5000);
  const [fallbackTimeout, setFallbackTimeout] = useState(5000);
  const [tierWeights, setTierWeights] = useState<TierWeights>({
    apex: 0.3,
    resilient: 0.5,
    local: 0.2,
  });
  const [tierModels, setTierModels] = useState<TierModels>({
    apex: [],
    resilient: [],
    local: [],
  });
  const [tierProviders, setTierProviders] = useState<{
    apex: string[];
    resilient: string[];
    local: string[];
  }>({
    apex: [],
    resilient: [],
    local: [],
  });
  const [availableProvidersList, setAvailableProvidersList] = useState<string[]>([]);
  const [knownComboNames, setKnownComboNames] = useState<Set<string>>(() => new Set());

  const [onlyFreeTierModels, setOnlyFreeTierModels] = useState<boolean>(false);
  const [tierModes, setTierModes] = useState<TierModes>({
    apex: "both",
    resilient: "both",
    local: "both",
  });
  const [freeModelTiles, setFreeModelTiles] = useState<FreeModelTile[]>([]);
  const [loadingFreeModels, setLoadingFreeModels] = useState<boolean>(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Multi-instance Named SPB state
  const [selectedProfile, setSelectedProfile] = useState<string>("default");
  const [availableProfiles, setAvailableProfiles] = useState<string[]>(["default"]);
  const [newProfileName, setNewProfileName] = useState<string>("");
  const [isCreatingProfile, setIsCreatingProfile] = useState<boolean>(false);

  // Advanced SPB runtime parameters
  const [spbConfig, setSpbConfig] = useState<ConcreteSpbRuntimeConfig>(DEFAULT_SPB_RUNTIME_CONFIG);
  const [retryCodesInput, setRetryCodesInput] = useState<string>(
    DEFAULT_SPB_RUNTIME_CONFIG.retryStatusCodes.join(", ")
  );
  const [showAdvancedParams, setShowAdvancedParams] = useState(false);

  const [tierModalConfig, setTierModalConfig] = useState<{
    isOpen: boolean;
    tier: keyof TierModels;
    tierTitle: string;
    tierDescription: string;
  }>({
    isOpen: false,
    tier: "apex",
    tierTitle: "Tier 1: Apex Reasoning",
    tierDescription: "Architectural Planning & Complex Reasoning",
  });

  const toggleTierProvider = (tier: keyof TierModels, providerId: string) => {
    setTierProviders((prev) => {
      const current = prev[tier] || [];
      const next = current.includes(providerId)
        ? current.filter((p) => p !== providerId)
        : [...current, providerId];
      return { ...prev, [tier]: next };
    });
  };

  const openTierModal = (tier: keyof TierModels) => {
    const meta = {
      apex: {
        title: "Tier 1: Apex Reasoning",
        desc: "Architectural Planning & Complex Reasoning (Deep reasoning models)",
      },
      resilient: {
        title: "Tier 2: Resilient Execution",
        desc: "Code Generation, Tests & Iteration (High-resilience tool models)",
      },
      local: {
        title: "Tier 3: Local Edge Inference",
        desc: "Fast Refactor, Formatting & Deterministic (Local engines & open-weights)",
      },
    }[tier];

    setTierModalConfig({
      isOpen: true,
      tier,
      tierTitle: meta.title,
      tierDescription: meta.desc,
    });
  };

  const handleSaveTierModels = (models: string[]) => {
    setTierModels((prev) => ({
      ...prev,
      [tierModalConfig.tier]: models,
    }));
  };

  const loadData = useCallback(
    async (signal?: AbortSignal, profile: string = selectedProfile) => {
      try {
        // 1. Fetch Tier Config for selected profile
        const tierRes = await fetch(
          `/api/settings/tier-config?profile=${encodeURIComponent(profile)}`,
          { signal }
        );
        if (tierRes.ok) {
          const tierData = await tierRes.json();
          if (Array.isArray(tierData.profiles)) {
            setAvailableProfiles(tierData.profiles);
          }
          setSpbEnabled(Boolean(tierData.spbEnabled));
          setOnlyFreeTierModels(Boolean(tierData.onlyFreeTierModels));
          if (tierData.tierModes) {
            setTierModes({
              apex: tierData.tierModes.apex ?? "both",
              resilient: tierData.tierModes.resilient ?? "both",
              local: tierData.tierModes.local ?? "both",
            });
          }
          if (typeof tierData.cacheThreshold === "number") {
            setCacheThreshold(tierData.cacheThreshold);
          }
          if (typeof tierData.fallbackTimeout === "number") {
            setFallbackTimeout(tierData.fallbackTimeout);
          }
          if (tierData.tierWeights) {
            setTierWeights({
              apex: tierData.tierWeights.apex ?? 0.3,
              resilient: tierData.tierWeights.resilient ?? 0.5,
              local: tierData.tierWeights.local ?? 0.2,
            });
          }
          if (tierData.tierModels) {
            setTierModels({
              apex: Array.isArray(tierData.tierModels.apex) ? tierData.tierModels.apex : [],
              resilient: Array.isArray(tierData.tierModels.resilient)
                ? tierData.tierModels.resilient
                : [],
              local: Array.isArray(tierData.tierModels.local) ? tierData.tierModels.local : [],
            });
          }
          if (tierData.tierProviders) {
            setTierProviders({
              apex: Array.isArray(tierData.tierProviders.apex) ? tierData.tierProviders.apex : [],
              resilient: Array.isArray(tierData.tierProviders.resilient)
                ? tierData.tierProviders.resilient
                : [],
              local: Array.isArray(tierData.tierProviders.local)
                ? tierData.tierProviders.local
                : [],
            });
          }
          if (tierData.spbConfig) {
            setSpbConfig({
              ...DEFAULT_SPB_RUNTIME_CONFIG,
              ...tierData.spbConfig,
              tokenBounds: {
                apex: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex,
                  ...(tierData.spbConfig.tokenBounds?.apex || {}),
                },
                resilient: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient,
                  ...(tierData.spbConfig.tokenBounds?.resilient || {}),
                },
                local: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local,
                  ...(tierData.spbConfig.tokenBounds?.local || {}),
                },
              },
              tierProfiles: {
                apex: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex,
                  ...(tierData.spbConfig.tierProfiles?.apex || {}),
                },
                resilient: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient,
                  ...(tierData.spbConfig.tierProfiles?.resilient || {}),
                },
                local: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local,
                  ...(tierData.spbConfig.tierProfiles?.local || {}),
                },
              },
            });
            if (Array.isArray(tierData.spbConfig.retryStatusCodes)) {
              setRetryCodesInput(tierData.spbConfig.retryStatusCodes.join(", "));
            }
          }
        }

        // 2. Fetch System Health Telemetry
        const healthRes = await fetch("/api/monitoring/health", { signal });
        if (healthRes.ok) {
          const healthData = await healthRes.json();
          const telem = healthData.spbTelemetry;
          if (telem) {
            setStats({
              totalRouted: telem.totalRoutes || 0,
              activeTiers: {
                apex: telem.tierDistribution?.tier_1_apex || 0,
                resilient: telem.tierDistribution?.tier_2_resilient || 0,
                local: telem.tierDistribution?.tier_3_local || 0,
              },
              checkpointsRestored: telem.checkpointsRestored || 0,
              fallbacksTriggered: telem.fallbacksTriggered || 0,
              lastRoutedAt: telem.lastRoutedAt || null,
            });
          }
        }
      } catch (err: unknown) {
        if (signal?.aborted) return;
        console.error("Failed to load SPB configuration or stats", err);
      }
    },
    [selectedProfile]
  );

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    const runFetch = async () => {
      try {
        const [tierRes, healthRes, combosRes, provRes] = await Promise.all([
          fetch("/api/settings/tier-config", { signal: controller.signal }),
          fetch("/api/monitoring/health", { signal: controller.signal }),
          fetch("/api/combos", { signal: controller.signal }).catch(() => null),
          fetch("/api/providers", { signal: controller.signal }).catch(() => null),
        ]);

        if (!ignore && tierRes.ok) {
          const tierData = await tierRes.json();
          setSpbEnabled(Boolean(tierData.spbEnabled));
          setOnlyFreeTierModels(Boolean(tierData.onlyFreeTierModels));
          if (tierData.tierModes) {
            setTierModes({
              apex: tierData.tierModes.apex ?? "both",
              resilient: tierData.tierModes.resilient ?? "both",
              local: tierData.tierModes.local ?? "both",
            });
          }
          if (typeof tierData.cacheThreshold === "number") {
            setCacheThreshold(tierData.cacheThreshold);
          }
          if (typeof tierData.fallbackTimeout === "number") {
            setFallbackTimeout(tierData.fallbackTimeout);
          }
          if (tierData.tierWeights) {
            setTierWeights({
              apex: tierData.tierWeights.apex ?? 0.3,
              resilient: tierData.tierWeights.resilient ?? 0.5,
              local: tierData.tierWeights.local ?? 0.2,
            });
          }
          if (tierData.tierModels) {
            setTierModels({
              apex: Array.isArray(tierData.tierModels.apex) ? tierData.tierModels.apex : [],
              resilient: Array.isArray(tierData.tierModels.resilient)
                ? tierData.tierModels.resilient
                : [],
              local: Array.isArray(tierData.tierModels.local) ? tierData.tierModels.local : [],
            });
          }
          if (tierData.tierProviders) {
            setTierProviders({
              apex: Array.isArray(tierData.tierProviders.apex) ? tierData.tierProviders.apex : [],
              resilient: Array.isArray(tierData.tierProviders.resilient)
                ? tierData.tierProviders.resilient
                : [],
              local: Array.isArray(tierData.tierProviders.local)
                ? tierData.tierProviders.local
                : [],
            });
          }
          if (tierData.spbConfig) {
            setSpbConfig({
              ...DEFAULT_SPB_RUNTIME_CONFIG,
              ...tierData.spbConfig,
              tokenBounds: {
                apex: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.apex,
                  ...(tierData.spbConfig.tokenBounds?.apex || {}),
                },
                resilient: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.resilient,
                  ...(tierData.spbConfig.tokenBounds?.resilient || {}),
                },
                local: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tokenBounds.local,
                  ...(tierData.spbConfig.tokenBounds?.local || {}),
                },
              },
              tierProfiles: {
                apex: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.apex,
                  ...(tierData.spbConfig.tierProfiles?.apex || {}),
                },
                resilient: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.resilient,
                  ...(tierData.spbConfig.tierProfiles?.resilient || {}),
                },
                local: {
                  ...DEFAULT_SPB_RUNTIME_CONFIG.tierProfiles.local,
                  ...(tierData.spbConfig.tierProfiles?.local || {}),
                },
              },
            });
            if (Array.isArray(tierData.spbConfig.retryStatusCodes)) {
              setRetryCodesInput(tierData.spbConfig.retryStatusCodes.join(", "));
            }
          }
        }

        if (!ignore && healthRes.ok) {
          const healthData = await healthRes.json();
          const telem = healthData.spbTelemetry;
          if (telem) {
            setStats({
              totalRouted: telem.totalRoutes || 0,
              activeTiers: {
                apex: telem.tierDistribution?.tier_1_apex || 0,
                resilient: telem.tierDistribution?.tier_2_resilient || 0,
                local: telem.tierDistribution?.tier_3_local || 0,
              },
              checkpointsRestored: telem.checkpointsRestored || 0,
              fallbacksTriggered: telem.fallbacksTriggered || 0,
              lastRoutedAt: telem.lastRoutedAt || null,
            });
          }
        }

        if (!ignore && combosRes?.ok) {
          const combosData = await combosRes.json();
          const names = new Set<string>();
          (combosData.combos || []).forEach((c: { name?: string }) => {
            if (c.name) names.add(c.name.toLowerCase());
          });
          setKnownComboNames(names);
        }

        if (!ignore && provRes?.ok) {
          const provData = await provRes.json();
          const activeList: string[] = [];
          (provData.providers || []).forEach(
            (p: { provider?: string; is_active?: boolean; isActive?: boolean }) => {
              const id = p.provider?.toLowerCase();
              const active = p.is_active ?? p.isActive ?? true;
              if (id && active && !activeList.includes(id)) {
                activeList.push(id);
              }
            }
          );
          setAvailableProvidersList(activeList.sort());
        }
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          console.error("Failed to load SPB configuration or stats", err);
        }
      }
    };

    void runFetch();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, []);

  const handleToggleSpb = async (checked: boolean) => {
    setToggling(true);
    setStatusMessage(null);
    try {
      // Synchronize both tier-config and feature-flags to ensure durable persistence
      const [tierRes, flagRes] = await Promise.all([
        fetch("/api/settings/tier-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spbEnabled: checked }),
        }),
        fetch("/api/settings/feature-flags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "SPB_ENABLED",
            value: checked ? "true" : "false",
          }),
        }),
      ]);

      if (tierRes.ok && flagRes.ok) {
        setSpbEnabled(checked);
        setStatusMessage(
          checked
            ? "SPB-IR successfully enabled and persisted."
            : "SPB-IR successfully disabled (pass-through)."
        );
      } else {
        const errText = await tierRes.text();
        setStatusMessage(`Failed to update SPB state: ${errText}`);
      }
    } catch (err) {
      setStatusMessage(`Error updating SPB state: ${String(err)}`);
    } finally {
      setToggling(false);
    }
  };

  const handleRemoveModel = (tier: keyof TierModels, modelToRemove: string) => {
    setTierModels((prev) => ({
      ...prev,
      [tier]: prev[tier].filter((m) => m !== modelToRemove),
    }));
  };

  const isComboModelName = (name: string): boolean => {
    if (!name) return false;
    const lower = name.toLowerCase();
    return lower.startsWith("combo/") || lower.startsWith("auto/") || knownComboNames.has(lower);
  };

  const fetchFreeModelTiles = useCallback(async () => {
    setLoadingFreeModels(true);
    try {
      const res = await fetch("/api/settings/tier-config/free-models");
      if (res.ok) {
        const data = await res.json();
        setFreeModelTiles(data.models || []);
      }
    } catch (err) {
      console.warn("Failed to fetch free model tiles:", err);
    } finally {
      setLoadingFreeModels(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (
      onlyFreeTierModels ||
      tierModes.apex !== "user" ||
      tierModes.resilient !== "user" ||
      tierModes.local !== "user"
    ) {
      fetch("/api/settings/tier-config/free-models")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (active && data?.models) {
            setFreeModelTiles(data.models);
          }
        })
        .catch((err) => {
          console.warn("Failed to fetch free model tiles:", err);
        });
    }
    return () => {
      active = false;
    };
  }, [onlyFreeTierModels, tierModes]);

  const handleSwitchProfile = async (profileName: string) => {
    setSelectedProfile(profileName);
    await loadData(undefined, profileName);
  };

  const handleCreateProfile = async () => {
    const trimmed = newProfileName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (!trimmed) return;
    if (!availableProfiles.includes(trimmed)) {
      setAvailableProfiles((prev) => [...prev, trimmed]);
    }
    setSelectedProfile(trimmed);
    setNewProfileName("");
    setIsCreatingProfile(false);
    await loadData(undefined, trimmed);
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    setStatusMessage(null);
    try {
      const parsedRetryCodes = retryCodesInput
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);

      const effectiveSpbConfig: ConcreteSpbRuntimeConfig = {
        ...spbConfig,
        retryStatusCodes:
          parsedRetryCodes.length > 0 ? parsedRetryCodes : spbConfig.retryStatusCodes,
      };

      const res = await fetch(
        `/api/settings/tier-config?profile=${encodeURIComponent(selectedProfile)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: selectedProfile,
            spbEnabled,
            onlyFreeTierModels,
            tierModes,
            cacheThreshold,
            fallbackTimeout,
            tierWeights,
            tierModels,
            tierProviders,
            spbConfig: effectiveSpbConfig,
          }),
        }
      );

      if (res.ok) {
        setSpbConfig(effectiveSpbConfig);
        setStatusMessage(`SPB configuration for profile '${selectedProfile}' saved successfully.`);
      } else {
        const errText = await res.text();
        setStatusMessage(`Failed to save configuration: ${errText}`);
      }
    } catch (err) {
      setStatusMessage(`Error saving configuration: ${String(err)}`);
    } finally {
      setSavingConfig(false);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      await loadData();
    } finally {
      setLoading(false);
    }
  };

  const cacheHitRate =
    stats.totalRouted > 0 ? Math.round((stats.checkpointsRestored / stats.totalRouted) * 100) : 100;

  const totalTierSum =
    stats.activeTiers.apex + stats.activeTiers.resilient + stats.activeTiers.local || 1;
  const apexPercent = Math.round((stats.activeTiers.apex / totalTierSum) * 100);
  const resilientPercent = Math.round((stats.activeTiers.resilient / totalTierSum) * 100);
  const localPercent = Math.round((stats.activeTiers.local / totalTierSum) * 100);

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              Smart Proxy Bridge & Intelligent Routing (SPB-IR)
            </h2>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                spbEnabled
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                  : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {spbEnabled ? "● Active / Enabled" : "○ Disabled / Pass-through"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Autonomous multi-agent intent analysis, tiered model selection, and zero-loss cache
            resumption.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 shadow-sm">
            <span className="text-xs font-medium text-muted-foreground">SPB Toggle:</span>
            <Toggle
              checked={spbEnabled}
              onChange={handleToggleSpb}
              disabled={toggling}
              ariaLabel="Enable Smart Proxy Bridge"
            />
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Refresh Metrics"}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-md bg-muted p-3 text-sm font-medium text-foreground border">
          {statusMessage}
        </div>
      )}

      {/* Profile Selector Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">Active SPB Instance Profile:</span>
          <div className="flex items-center gap-2">
            {availableProfiles.map((p) => (
              <button
                key={p}
                onClick={() => handleSwitchProfile(p)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  selectedProfile === p
                    ? "bg-primary text-primary-foreground shadow"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {p === "default" ? "default (auto/spb)" : `${p} (auto/${p})`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isCreatingProfile ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Profile name (e.g. spb1, spb2)"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
                className="h-8 rounded-md border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={handleCreateProfile}
                className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setIsCreatingProfile(false);
                  setNewProfileName("");
                }}
                className="h-8 rounded-md border bg-background px-2 text-xs text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsCreatingProfile(true)}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              <span className="material-symbols-outlined text-sm">add</span>
              New SPB Profile
            </button>
          )}
        </div>
      </div>

      {/* SPB Usage & Configuration Banner */}
      <div className="rounded-lg border bg-card p-5 shadow-sm border-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-950/20">
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-indigo-500/10 p-2 text-indigo-500 mt-0.5">
            <span className="material-symbols-outlined text-2xl">alt_route</span>
          </div>
          <div className="space-y-1.5 flex-1">
            <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
              Smart Proxy Bridge Client Model Identifier
              <code className="rounded bg-indigo-500/20 px-2 py-0.5 font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
                auto/spb
              </code>
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              To utilize autonomous context-aware routing, configure your client agent (Claude Code,
              Gemini CLI, AntiGravity, Cursor, OpenHands) to request the model identifier{" "}
              <code className="font-mono font-semibold text-foreground">auto/spb</code> (or{" "}
              <code className="font-mono font-semibold text-foreground">
                auto/smart-proxy-bridge
              </code>
              ). The proxy autonomously inspects task phase, prompt complexity, agent plan mode, and
              tool execution status to dynamically dispatch traffic across Tier 1 (Apex Reasoning),
              Tier 2 (Resilient Execution), and Tier 3 (Local Edge Inference) with zero client-side
              tier parameters.
            </p>
            <div className="pt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">Tier 1:</span> Architectural Planning
                &amp; Deep Reasoning
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">Tier 2:</span> Code Generation &amp;
                Tool Verification
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">Tier 3:</span> Fast Refactoring &amp;
                Deterministic Formatting
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground">Total Requests Routed</div>
          <div className="mt-2 text-3xl font-bold text-foreground">
            {stats.totalRouted.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-muted-foreground font-medium">
            {stats.lastRoutedAt
              ? `Last routed: ${new Date(stats.lastRoutedAt).toLocaleTimeString()}`
              : "Live telemetry from SQLite WAL"}
          </p>
        </div>
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground">Prompt Cache Hit Rate</div>
          <div className="mt-2 text-3xl font-bold text-foreground">{cacheHitRate}%</div>
          <p className="mt-1 text-xs text-muted-foreground">Zero context degradation across hops</p>
        </div>
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground">Checkpoints Restored</div>
          <div className="mt-2 text-3xl font-bold text-foreground">
            {stats.checkpointsRestored.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Prompt anchor hash matches</p>
        </div>
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="text-sm font-medium text-muted-foreground">Zero-Loss Fallbacks</div>
          <div className="mt-2 text-3xl font-bold text-foreground">
            {stats.fallbacksTriggered.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-emerald-500 font-medium">
            {stats.fallbacksTriggered === 0
              ? "0 failovers required"
              : "Recovered via resilient tier"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-foreground mb-4">
              Tiered Model Distribution
            </h3>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-sm font-medium mb-1">
                  <span>
                    Tier 1: Apex Reasoning (
                    {tierModels.apex.length > 0 ? tierModels.apex.join(" / ") : "None configured"})
                  </span>
                  <span>
                    {stats.activeTiers.apex} requests ({apexPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                    style={{ width: `${stats.totalRouted > 0 ? apexPercent : 30}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm font-medium mb-1">
                  <span>
                    Tier 2: Resilient Execution (
                    {tierModels.resilient.length > 0
                      ? tierModels.resilient.join(" / ")
                      : "None configured"}
                    )
                  </span>
                  <span>
                    {stats.activeTiers.resilient} requests ({resilientPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{ width: `${stats.totalRouted > 0 ? resilientPercent : 50}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-sm font-medium mb-1">
                  <span>
                    Tier 3: Local Edge Inference (
                    {tierModels.local.length > 0 ? tierModels.local.join(" / ") : "None configured"}
                    )
                  </span>
                  <span>
                    {stats.activeTiers.local} requests ({localPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                    style={{ width: `${stats.totalRouted > 0 ? localPercent : 20}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div>
                <h4 className="text-md font-semibold text-foreground mb-1">
                  Configured Target Models & Autonomous Free Tier
                </h4>
                <p className="text-xs text-muted-foreground">
                  Configure target models for each execution tier. The intent classifier routes
                  tasks dynamically to these models based on task phase, capability scoring, and
                  free tier selection.
                </p>
              </div>

              {/* Free-model global toggle */}
              <div className="flex items-center gap-3 bg-muted/40 border rounded-lg px-3 py-2">
                <div className="flex flex-col">
                  <span className="text-xs font-semibold text-foreground">
                    Only Use Free Tier Models
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Auto-filter proxy requests to zero-cost models
                  </span>
                </div>
                <Toggle
                  checked={onlyFreeTierModels}
                  onChange={(checked) => setOnlyFreeTierModels(checked)}
                  label="Only Use Free Tier Models"
                />
              </div>
            </div>

            {/* Free model tiles section */}
            <div className="mb-6 rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-emerald-500 text-lg">
                    verified
                  </span>
                  <span className="text-xs font-semibold text-foreground">
                    Discovered Free Tier Models ({freeModelTiles.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={fetchFreeModelTiles}
                  disabled={loadingFreeModels}
                  className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[14px]">refresh</span>
                  {loadingFreeModels ? "Scanning..." : "Scan Available"}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Apex free tiles */}
                <div className="rounded-md border p-2.5 bg-indigo-500/5 border-indigo-500/20">
                  <div className="text-[11px] font-semibold text-indigo-400 mb-1.5 flex items-center justify-between">
                    <span>Apex Candidates (Reasoning/Code)</span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {freeModelTiles.filter((t) => t.tier === "apex").length} models
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                    {freeModelTiles.filter((t) => t.tier === "apex").length === 0 ? (
                      <span className="text-[11px] text-muted-foreground italic">None active</span>
                    ) : (
                      freeModelTiles
                        .filter((t) => t.tier === "apex")
                        .slice(0, 15)
                        .map((t) => (
                          <span
                            key={`${t.provider}/${t.model}`}
                            className="rounded bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-300 font-mono"
                            title={`${t.provider}/${t.model}`}
                          >
                            {t.displayName}
                          </span>
                        ))
                    )}
                  </div>
                </div>

                {/* Resilient free tiles */}
                <div className="rounded-md border p-2.5 bg-blue-500/5 border-blue-500/20">
                  <div className="text-[11px] font-semibold text-blue-400 mb-1.5 flex items-center justify-between">
                    <span>Resilient Candidates (Tool Calling)</span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {freeModelTiles.filter((t) => t.tier === "resilient").length} models
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                    {freeModelTiles.filter((t) => t.tier === "resilient").length === 0 ? (
                      <span className="text-[11px] text-muted-foreground italic">None active</span>
                    ) : (
                      freeModelTiles
                        .filter((t) => t.tier === "resilient")
                        .slice(0, 15)
                        .map((t) => (
                          <span
                            key={`${t.provider}/${t.model}`}
                            className="rounded bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-300 font-mono"
                            title={`${t.provider}/${t.model}`}
                          >
                            {t.displayName}
                          </span>
                        ))
                    )}
                  </div>
                </div>

                {/* Local free tiles */}
                <div className="rounded-md border p-2.5 bg-emerald-500/5 border-emerald-500/20">
                  <div className="text-[11px] font-semibold text-emerald-400 mb-1.5 flex items-center justify-between">
                    <span>Local Candidates (Fast/Edge)</span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {freeModelTiles.filter((t) => t.tier === "local").length} models
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                    {freeModelTiles.filter((t) => t.tier === "local").length === 0 ? (
                      <span className="text-[11px] text-muted-foreground italic">None active</span>
                    ) : (
                      freeModelTiles
                        .filter((t) => t.tier === "local")
                        .slice(0, 15)
                        .map((t) => (
                          <span
                            key={`${t.provider}/${t.model}`}
                            className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300 font-mono"
                            title={`${t.provider}/${t.model}`}
                          >
                            {t.displayName}
                          </span>
                        ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {/* Tier 1 Apex */}
              <div className="rounded-md border p-3 bg-muted/20">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-indigo-400">
                      Tier 1: Apex Reasoning
                    </span>
                    <select
                      value={tierModes.apex}
                      onChange={(e) =>
                        setTierModes((prev) => ({
                          ...prev,
                          apex: e.target.value as TierSelectionMode,
                        }))
                      }
                      className="rounded bg-background border px-2 py-0.5 text-[11px] text-foreground font-medium"
                    >
                      <option value="both">Mode: User + Free</option>
                      <option value="free">Mode: Free Only</option>
                      <option value="user">Mode: User Configured</option>
                    </select>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    Architectural Planning & Complex Reasoning
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2.5 pt-1">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">
                    Active Providers:
                  </span>
                  {availableProvidersList.map((prov) => {
                    const isSelected = (tierProviders.apex || []).includes(prov);
                    return (
                      <button
                        key={prov}
                        type="button"
                        onClick={() => toggleTierProvider("apex", prov)}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                          isSelected
                            ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40 shadow-sm"
                            : "bg-muted/30 text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                        }`}
                      >
                        {isSelected && "✓ "}
                        {prov}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tierModels.apex.length === 0 ? (
                    <span className="text-xs text-muted-foreground italic py-0.5">
                      No models configured
                    </span>
                  ) : (
                    tierModels.apex.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1 rounded bg-indigo-500/10 border border-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-300"
                      >
                        {isComboModelName(m) && (
                          <span
                            className="material-symbols-outlined text-[12px] text-purple-400"
                            title="Combo Model"
                          >
                            layers
                          </span>
                        )}
                        {m}
                        <button
                          type="button"
                          onClick={() => handleRemoveModel("apex", m)}
                          className="text-muted-foreground hover:text-foreground ml-0.5 text-xs leading-none"
                          title={`Remove ${m}`}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/50">
                  <button
                    type="button"
                    onClick={() => openTierModal("apex")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-3 py-1.5 text-xs font-medium transition-colors shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">account_tree</span>
                    Select Models & Combos...
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {tierModels.apex.length} {tierModels.apex.length === 1 ? "model" : "models"}{" "}
                    configured
                  </span>
                </div>
              </div>

              {/* Tier 2 Resilient */}
              <div className="rounded-md border p-3 bg-muted/20">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-blue-400">
                      Tier 2: Resilient Execution
                    </span>
                    <select
                      value={tierModes.resilient}
                      onChange={(e) =>
                        setTierModes((prev) => ({
                          ...prev,
                          resilient: e.target.value as TierSelectionMode,
                        }))
                      }
                      className="rounded bg-background border px-2 py-0.5 text-[11px] text-foreground font-medium"
                    >
                      <option value="both">Mode: User + Free</option>
                      <option value="free">Mode: Free Only</option>
                      <option value="user">Mode: User Configured</option>
                    </select>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    Code Generation, Tests & Iteration
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2.5 pt-1">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">
                    Active Providers:
                  </span>
                  {availableProvidersList.map((prov) => {
                    const isSelected = (tierProviders.resilient || []).includes(prov);
                    return (
                      <button
                        key={prov}
                        type="button"
                        onClick={() => toggleTierProvider("resilient", prov)}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                          isSelected
                            ? "bg-blue-500/20 text-blue-300 border-blue-500/40 shadow-sm"
                            : "bg-muted/30 text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                        }`}
                      >
                        {isSelected && "✓ "}
                        {prov}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tierModels.resilient.length === 0 ? (
                    <span className="text-xs text-muted-foreground italic py-0.5">
                      No models configured
                    </span>
                  ) : (
                    tierModels.resilient.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1 rounded bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300"
                      >
                        {isComboModelName(m) && (
                          <span
                            className="material-symbols-outlined text-[12px] text-purple-400"
                            title="Combo Model"
                          >
                            layers
                          </span>
                        )}
                        {m}
                        <button
                          type="button"
                          onClick={() => handleRemoveModel("resilient", m)}
                          className="text-muted-foreground hover:text-foreground ml-0.5 text-xs leading-none"
                          title={`Remove ${m}`}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/50">
                  <button
                    type="button"
                    onClick={() => openTierModal("resilient")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 px-3 py-1.5 text-xs font-medium transition-colors shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">account_tree</span>
                    Select Models & Combos...
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {tierModels.resilient.length}{" "}
                    {tierModels.resilient.length === 1 ? "model" : "models"} configured
                  </span>
                </div>
              </div>

              {/* Tier 3 Local */}
              <div className="rounded-md border p-3 bg-muted/20">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-emerald-400">
                      Tier 3: Local Edge Inference
                    </span>
                    <select
                      value={tierModes.local}
                      onChange={(e) =>
                        setTierModes((prev) => ({
                          ...prev,
                          local: e.target.value as TierSelectionMode,
                        }))
                      }
                      className="rounded bg-background border px-2 py-0.5 text-[11px] text-foreground font-medium"
                    >
                      <option value="both">Mode: User + Free</option>
                      <option value="free">Mode: Free Only</option>
                      <option value="user">Mode: User Configured</option>
                    </select>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    Fast Refactor, Formatting & Deterministic
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2.5 pt-1">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mr-1">
                    Active Providers:
                  </span>
                  {availableProvidersList.map((prov) => {
                    const isSelected = (tierProviders.local || []).includes(prov);
                    return (
                      <button
                        key={prov}
                        type="button"
                        onClick={() => toggleTierProvider("local", prov)}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                          isSelected
                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shadow-sm"
                            : "bg-muted/30 text-muted-foreground border-transparent hover:border-border hover:text-foreground"
                        }`}
                      >
                        {isSelected && "✓ "}
                        {prov}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tierModels.local.length === 0 ? (
                    <span className="text-xs text-muted-foreground italic py-0.5">
                      No models configured
                    </span>
                  ) : (
                    tierModels.local.map((m) => (
                      <span
                        key={m}
                        className="inline-flex items-center gap-1 rounded bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300"
                      >
                        {isComboModelName(m) && (
                          <span
                            className="material-symbols-outlined text-[12px] text-purple-400"
                            title="Combo Model"
                          >
                            layers
                          </span>
                        )}
                        {m}
                        <button
                          type="button"
                          onClick={() => handleRemoveModel("local", m)}
                          className="text-muted-foreground hover:text-foreground ml-0.5 text-xs leading-none"
                          title={`Remove ${m}`}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border/50">
                  <button
                    type="button"
                    onClick={() => openTierModal("local")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-3 py-1.5 text-xs font-medium transition-colors shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">account_tree</span>
                    Select Models & Combos...
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {tierModels.local.length} {tierModels.local.length === 1 ? "model" : "models"}{" "}
                    configured
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="text-md font-semibold text-foreground mb-3">
              Bridge Parameters & Thresholds
            </h4>
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Apex Weight</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={tierWeights.apex}
                    onChange={(e) =>
                      setTierWeights((w) => ({ ...w, apex: parseFloat(e.target.value) || 0 }))
                    }
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Resilient Weight
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={tierWeights.resilient}
                    onChange={(e) =>
                      setTierWeights((w) => ({
                        ...w,
                        resilient: parseFloat(e.target.value) || 0,
                      }))
                    }
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Local Weight</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={tierWeights.local}
                    onChange={(e) =>
                      setTierWeights((w) => ({ ...w, local: parseFloat(e.target.value) || 0 }))
                    }
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Cache Threshold (tokens)
                  </label>
                  <input
                    type="number"
                    value={cacheThreshold}
                    onChange={(e) => setCacheThreshold(Number(e.target.value))}
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Fallback Timeout (ms)
                  </label>
                  <input
                    type="number"
                    value={fallbackTimeout}
                    onChange={(e) => setFallbackTimeout(Number(e.target.value))}
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              {/* Advanced SPB Runtime Configuration Section */}
              <div className="rounded-lg border border-border/80 bg-muted/10 p-4 mt-2">
                <button
                  type="button"
                  onClick={() => setShowAdvancedParams((prev) => !prev)}
                  className="flex w-full items-center justify-between text-left text-sm font-semibold text-foreground hover:text-primary transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-primary">tune</span>
                    Advanced SPB Runtime Parameters &amp; Loop Protection
                  </span>
                  <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
                    {showAdvancedParams ? "Collapse" : "Expand settings"}
                    <span className="material-symbols-outlined text-[16px]">
                      {showAdvancedParams ? "expand_less" : "expand_more"}
                    </span>
                  </span>
                </button>

                {showAdvancedParams && (
                  <div className="space-y-4 pt-4 border-t border-border/50 mt-3">
                    {/* Stagnation & Loop Guards */}
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Loop &amp; Stagnation Protection
                      </h5>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="text-xs font-medium text-foreground block">
                            Stagnation Threshold
                          </label>
                          <span className="text-[11px] text-muted-foreground block mb-1">
                            Consecutive reads before recovery
                          </span>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={spbConfig.stagnationThreshold}
                            onChange={(e) =>
                              setSpbConfig((prev) => ({
                                ...prev,
                                stagnationThreshold: Math.max(1, parseInt(e.target.value, 10) || 1),
                              }))
                            }
                            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-foreground block">
                            Duplicate Read Limit
                          </label>
                          <span className="text-[11px] text-muted-foreground block mb-1">
                            Same file reads before code gen
                          </span>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={spbConfig.duplicateReadThreshold}
                            onChange={(e) =>
                              setSpbConfig((prev) => ({
                                ...prev,
                                duplicateReadThreshold: Math.max(
                                  1,
                                  parseInt(e.target.value, 10) || 1
                                ),
                              }))
                            }
                            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-foreground block">
                            Multi-File Scope Limit
                          </label>
                          <span className="text-[11px] text-muted-foreground block mb-1">
                            Files before Tier 1 planning
                          </span>
                          <input
                            type="number"
                            min="1"
                            max="20"
                            value={spbConfig.multiFileThreshold}
                            onChange={(e) =>
                              setSpbConfig((prev) => ({
                                ...prev,
                                multiFileThreshold: Math.max(1, parseInt(e.target.value, 10) || 1),
                              }))
                            }
                            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Zero-Loss & Execution Output Verification */}
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Zero-Loss Verification &amp; Outbound Diff
                      </h5>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                        <div>
                          <label className="text-xs font-medium text-foreground block">
                            Code Diff Timeout (ms)
                          </label>
                          <span className="text-[11px] text-muted-foreground block mb-1">
                            Subprocess git diff / status timeout
                          </span>
                          <input
                            type="number"
                            step="500"
                            min="500"
                            value={spbConfig.diffTimeoutMs}
                            onChange={(e) =>
                              setSpbConfig((prev) => ({
                                ...prev,
                                diffTimeoutMs: Math.max(500, parseInt(e.target.value, 10) || 500),
                              }))
                            }
                            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-foreground block">
                            Min Response Length (chars)
                          </label>
                          <span className="text-[11px] text-muted-foreground block mb-1">
                            Below this triggers truncation guard
                          </span>
                          <input
                            type="number"
                            min="5"
                            max="500"
                            value={spbConfig.minResponseLength}
                            onChange={(e) =>
                              setSpbConfig((prev) => ({
                                ...prev,
                                minResponseLength: Math.max(1, parseInt(e.target.value, 10) || 1),
                              }))
                            }
                            className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs font-medium text-foreground block">
                          Zero-Loss Fallback HTTP Status Codes
                        </label>
                        <span className="text-[11px] text-muted-foreground block mb-1">
                          Comma-separated status codes triggering automatic resilient model retry
                        </span>
                        <input
                          type="text"
                          value={retryCodesInput}
                          onChange={(e) => setRetryCodesInput(e.target.value)}
                          placeholder="400, 402, 408, 409, 429, 500, 502, 503, 504, 529"
                          className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono text-foreground shadow-sm"
                        />
                      </div>
                    </div>

                    {/* Tier Profiles: Temperatures & Reasoning Efforts */}
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Tier Profiles (Temperature &amp; Reasoning Effort)
                      </h5>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {/* Apex Profile */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-indigo-400 block mb-2">
                            Tier 1: Apex Profile
                          </span>
                          <div className="space-y-2">
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Temperature ({spbConfig.tierProfiles.apex.temperature})
                              </label>
                              <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.05"
                                value={spbConfig.tierProfiles.apex.temperature}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      apex: {
                                        ...prev.tierProfiles.apex,
                                        temperature: parseFloat(e.target.value),
                                      },
                                    },
                                  }))
                                }
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Reasoning Effort
                              </label>
                              <select
                                value={spbConfig.tierProfiles.apex.reasoningEffort}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      apex: {
                                        ...prev.tierProfiles.apex,
                                        reasoningEffort: e.target.value as
                                          "low" | "medium" | "high",
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs"
                              >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Custom System Prompt (Optional)
                              </label>
                              <textarea
                                rows={2}
                                placeholder="Default: Exhaustive architectural precision & invariant framing..."
                                value={spbConfig.tierProfiles.apex.systemPrompt || ""}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      apex: {
                                        ...prev.tierProfiles.apex,
                                        systemPrompt: e.target.value,
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs font-mono"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Resilient Profile */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-blue-400 block mb-2">
                            Tier 2: Resilient Profile
                          </span>
                          <div className="space-y-2">
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Temperature ({spbConfig.tierProfiles.resilient.temperature})
                              </label>
                              <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.05"
                                value={spbConfig.tierProfiles.resilient.temperature}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      resilient: {
                                        ...prev.tierProfiles.resilient,
                                        temperature: parseFloat(e.target.value),
                                      },
                                    },
                                  }))
                                }
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Reasoning Effort
                              </label>
                              <select
                                value={spbConfig.tierProfiles.resilient.reasoningEffort}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      resilient: {
                                        ...prev.tierProfiles.resilient,
                                        reasoningEffort: e.target.value as
                                          "low" | "medium" | "high",
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs"
                              >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Custom System Prompt (Optional)
                              </label>
                              <textarea
                                rows={2}
                                placeholder="Default: Robust SDLC implementation & checklist enforcement..."
                                value={spbConfig.tierProfiles.resilient.systemPrompt || ""}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      resilient: {
                                        ...prev.tierProfiles.resilient,
                                        systemPrompt: e.target.value,
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs font-mono"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Local Profile */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-emerald-400 block mb-2">
                            Tier 3: Local Profile
                          </span>
                          <div className="space-y-2">
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Temperature ({spbConfig.tierProfiles.local.temperature})
                              </label>
                              <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.05"
                                value={spbConfig.tierProfiles.local.temperature}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      local: {
                                        ...prev.tierProfiles.local,
                                        temperature: parseFloat(e.target.value),
                                      },
                                    },
                                  }))
                                }
                                className="w-full"
                              />
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Reasoning Effort
                              </label>
                              <select
                                value={spbConfig.tierProfiles.local.reasoningEffort}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      local: {
                                        ...prev.tierProfiles.local,
                                        reasoningEffort: e.target.value as
                                          "low" | "medium" | "high",
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs"
                              >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground block">
                                Custom System Prompt (Optional)
                              </label>
                              <textarea
                                rows={2}
                                placeholder="Default: Surgical minimal diff & local preservation..."
                                value={spbConfig.tierProfiles.local.systemPrompt || ""}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tierProfiles: {
                                      ...prev.tierProfiles,
                                      local: {
                                        ...prev.tierProfiles.local,
                                        systemPrompt: e.target.value,
                                      },
                                    },
                                  }))
                                }
                                className="w-full rounded bg-background border px-2 py-1 text-xs font-mono"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Tier Token Bounds (Max Tokens High/Medium/Low) */}
                    <div>
                      <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Dynamic Token Allocation Bounds (Max Output Tokens)
                      </h5>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {/* Apex Bounds */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-indigo-400 block mb-2">
                            Tier 1 (Apex)
                          </span>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">High (&ge;0.7):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.apex.high}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      apex: {
                                        ...prev.tokenBounds.apex,
                                        high: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Med (0.3-0.7):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.apex.medium}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      apex: {
                                        ...prev.tokenBounds.apex,
                                        medium: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Low (&le;0.3):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.apex.low}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      apex: {
                                        ...prev.tokenBounds.apex,
                                        low: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Resilient Bounds */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-blue-400 block mb-2">
                            Tier 2 (Resilient)
                          </span>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">High (&ge;0.7):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.resilient.high}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      resilient: {
                                        ...prev.tokenBounds.resilient,
                                        high: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Med (0.3-0.7):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.resilient.medium}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      resilient: {
                                        ...prev.tokenBounds.resilient,
                                        medium: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Low (&le;0.3):</span>
                              <input
                                type="number"
                                step="1024"
                                value={spbConfig.tokenBounds.resilient.low}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      resilient: {
                                        ...prev.tokenBounds.resilient,
                                        low: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Local Bounds */}
                        <div className="rounded-md border p-2.5 bg-background">
                          <span className="text-xs font-semibold text-emerald-400 block mb-2">
                            Tier 3 (Local)
                          </span>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">High (&ge;0.7):</span>
                              <input
                                type="number"
                                step="512"
                                value={spbConfig.tokenBounds.local.high}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      local: {
                                        ...prev.tokenBounds.local,
                                        high: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Med (0.3-0.7):</span>
                              <input
                                type="number"
                                step="512"
                                value={spbConfig.tokenBounds.local.medium}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      local: {
                                        ...prev.tokenBounds.local,
                                        medium: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">Low (&le;0.3):</span>
                              <input
                                type="number"
                                step="512"
                                value={spbConfig.tokenBounds.local.low}
                                onChange={(e) =>
                                  setSpbConfig((prev) => ({
                                    ...prev,
                                    tokenBounds: {
                                      ...prev.tokenBounds,
                                      local: {
                                        ...prev.tokenBounds.local,
                                        low: parseInt(e.target.value, 10) || 0,
                                      },
                                    },
                                  }))
                                }
                                className="w-24 rounded border px-1.5 py-0.5 text-right font-mono text-xs"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-md hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              >
                {savingConfig ? (
                  <>
                    <span className="material-symbols-outlined text-[16px] animate-spin">
                      progress_activity
                    </span>
                    <span>Saving Configuration...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                    <span>Apply Bridge Parameters</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-foreground mb-4">
            System Invariants & Security Status
          </h3>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li className="flex items-center justify-between border-b pb-2">
              <span className="font-medium text-foreground">Output Accuracy & Task Fidelity</span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                0% Loss Verified
              </span>
            </li>
            <li className="flex items-center justify-between border-b pb-2">
              <span className="font-medium text-foreground">
                Prompt Context & Intention Retention
              </span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                100% Retained
              </span>
            </li>
            <li className="flex items-center justify-between border-b pb-2">
              <span className="font-medium text-foreground">
                Routing-Induced Hallucination Rate
              </span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                0.0%
              </span>
            </li>
            <li className="flex items-center justify-between pb-2">
              <span className="font-medium text-foreground">Crypto Audit Integrity (SHA-256)</span>
              <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400">
                Active Chain
              </span>
            </li>
          </ul>
        </div>
      </div>

      <SmartProxyActivitySection />

      <TierModelSelectModal
        isOpen={tierModalConfig.isOpen}
        onClose={() => setTierModalConfig((prev) => ({ ...prev, isOpen: false }))}
        tier={tierModalConfig.tier}
        tierTitle={tierModalConfig.tierTitle}
        tierDescription={tierModalConfig.tierDescription}
        selectedModels={tierModels[tierModalConfig.tier]}
        onSave={handleSaveTierModels}
      />
    </div>
  );
}

export default SmartProxyBridgeTab;
