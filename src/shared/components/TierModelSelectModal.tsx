"use client";

import React, { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import {
  type SpbTierKey,
  type CapabilityFilterKey,
  type TierSelectableModel,
  detectModelCapabilities,
  detectComboCapabilities,
  isModelEligibleForTier,
  matchesCapabilityFilters,
  getTierColorClass,
} from "./tierModelSelectHelpers";
import {
  AI_PROVIDERS,
  LOCAL_PROVIDERS,
  OAUTH_PROVIDERS,
  NOAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
} from "@/shared/constants/providers";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

export interface TierModelSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  tier: SpbTierKey;
  tierTitle: string;
  tierDescription?: string;
  selectedModels: string[];
  onSave: (models: string[]) => void;
}

interface ProviderConnection {
  id?: string;
  provider: string;
  name?: string;
  isActive?: boolean;
  baseUrl?: string;
  apiUrl?: string;
  status?: string;
}

interface ComboItem {
  id?: string;
  name?: string;
  strategy?: string;
  models?: Array<string | { model?: string; providerId?: string }>;
  description?: string;
  computed_context_length?: number;
}

export default function TierModelSelectModal({
  isOpen,
  onClose,
  tier,
  tierTitle,
  tierDescription,
  selectedModels,
  onSave,
}: TierModelSelectModalProps) {
  const [localSelected, setLocalSelected] = useState<Set<string>>(() => new Set(selectedModels));
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [customModels, setCustomModels] = useState<Record<string, unknown[]>>({});
  const [syncedModels, setSyncedModels] = useState<
    Record<string, Array<{ id?: string; name?: string }>>
  >({});
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCapabilityFilters, setActiveCapabilityFilters] = useState<Set<CapabilityFilterKey>>(
    () => new Set(["all"])
  );
  const [selectedProviderFilter, setSelectedProviderFilter] = useState<string>("all");
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(true);
  const [sortOrder, setSortOrder] = useState<"free-first" | "context-desc" | "name-asc">(
    "free-first"
  );
  const [customInput, setCustomInput] = useState("");

  // Render-time state adjustment when modal opens (avoids cascading render warning)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setLocalSelected(new Set(selectedModels));
      setSearchQuery("");
      setActiveCapabilityFilters(new Set(["all"]));
      setSelectedProviderFilter("all");
      setSortOrder("free-first");
      setCustomInput("");
    }
  }

  // Multi-select capability filter handler
  const handleToggleCapabilityFilter = (filterKey: CapabilityFilterKey) => {
    setActiveCapabilityFilters((prev) => {
      const next = new Set(prev);
      if (filterKey === "all") {
        return new Set(["all"]);
      }
      next.delete("all");
      if (next.has(filterKey)) {
        next.delete(filterKey);
        if (next.size === 0) {
          next.add("all");
        }
      } else {
        next.add(filterKey);
      }
      return next;
    });
  };

  // Fetch connections, custom models, synced catalog, and combos
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const loadData = async () => {
      try {
        const [connRes, customRes, syncedRes, combosRes] = await Promise.all([
          fetch("/api/providers").catch(() => null),
          fetch("/api/provider-models").catch(() => null),
          fetch("/api/synced-available-models").catch(() => null),
          fetch("/api/combos").catch(() => null),
        ]);

        if (!cancelled && connRes?.ok) {
          const connData = await connRes.json();
          setConnections(connData.connections || []);
        }

        if (!cancelled && customRes?.ok) {
          const customData = await customRes.json();
          setCustomModels(customData.models || {});
        }

        if (!cancelled && syncedRes?.ok) {
          const syncedData = await syncedRes.json();
          setSyncedModels(syncedData || {});
        }

        if (!cancelled && combosRes?.ok) {
          const combosData = await combosRes.json();
          setCombos(combosData.combos || []);
        }
      } catch (err) {
        console.error("Failed to load providers, models, or combos for tier selector:", err);
      }
    };

    loadData();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const activeProviderIds = useMemo(() => {
    const ids = new Set<string>();
    connections.forEach((c) => {
      if (c.isActive !== false && c.provider) {
        ids.add(c.provider.toLowerCase());
      }
    });
    return ids;
  }, [connections]);

  const allProvidersMap = useMemo(() => {
    return {
      ...AI_PROVIDERS,
      ...LOCAL_PROVIDERS,
      ...OAUTH_PROVIDERS,
      ...NOAUTH_PROVIDERS,
      ...APIKEY_PROVIDERS,
    };
  }, []);

  // Build the complete candidate model pool across all providers
  const allCandidateModels = useMemo<TierSelectableModel[]>(() => {
    const pool: TierSelectableModel[] = [];
    const seenValues = new Set<string>();

    const candidateProviderIds = Object.keys(allProvidersMap);

    candidateProviderIds.forEach((providerId) => {
      const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const providerMeta = (allProvidersMap as Record<string, { name?: string }>)[providerId] || {};
      const providerName = providerMeta.name || providerId;
      const isConfigured = activeProviderIds.has(providerId.toLowerCase());

      const connection = connections.find(
        (c) => c.provider?.toLowerCase() === providerId.toLowerCase()
      );
      const urlOrHost = connection?.baseUrl || connection?.apiUrl;

      // 1. Static registry models
      const staticModels = getModelsByProviderId(providerId) || [];
      staticModels.forEach((m) => {
        const fullValue = `${alias}/${m.id}`;
        const caps = detectModelCapabilities(providerId, m, urlOrHost);
        if (!seenValues.has(fullValue)) {
          seenValues.add(fullValue);
          pool.push({
            id: m.id,
            name: m.name || m.id,
            fullValue,
            providerId,
            providerAlias: alias,
            providerName,
            capabilities: caps,
            isConfigured,
          });
        }
      });

      // 2. Custom/operator-added models
      const providerCustom = (customModels[providerId] || []) as Array<{
        id: string;
        name?: string;
        toolCalling?: boolean;
        supportsReasoning?: boolean;
        alwaysReasons?: boolean;
        supportsVision?: boolean;
        contextLength?: number;
      }>;
      providerCustom.forEach((m) => {
        const fullValue = `${alias}/${m.id}`;
        const caps = detectModelCapabilities(providerId, m, urlOrHost);
        if (!seenValues.has(fullValue)) {
          seenValues.add(fullValue);
          pool.push({
            id: m.id,
            name: m.name || m.id,
            fullValue,
            providerId,
            providerAlias: alias,
            providerName,
            capabilities: caps,
            isConfigured,
          });
        }
      });

      // 3. Synced models from active upstream providers
      const providerSynced = (syncedModels[providerId] || []) as Array<{
        id: string;
        name?: string;
        toolCalling?: boolean;
        supportsReasoning?: boolean;
        alwaysReasons?: boolean;
        supportsVision?: boolean;
        contextLength?: number;
      }>;
      providerSynced.forEach((m) => {
        const fullValue = `${alias}/${m.id}`;
        const caps = detectModelCapabilities(providerId, m, urlOrHost);
        if (!seenValues.has(fullValue)) {
          seenValues.add(fullValue);
          pool.push({
            id: m.id,
            name: m.name || m.id,
            fullValue,
            providerId,
            providerAlias: alias,
            providerName,
            capabilities: caps,
            isConfigured,
          });
        }
      });
    });

    // 4. Combos pool (persisted user combos)
    combos.forEach((combo) => {
      const comboName = combo.name || combo.id;
      if (!comboName) return;
      const fullValue = comboName;
      const caps = detectComboCapabilities(combo);
      if (!seenValues.has(fullValue)) {
        seenValues.add(fullValue);
        const memberModels = (Array.isArray(combo.models) ? combo.models : []).map((m) =>
          typeof m === "string" ? m : m?.model || ""
        );
        pool.push({
          id: comboName,
          name: comboName,
          fullValue,
          providerId: "combo",
          providerAlias: "combo",
          providerName: "Combos",
          capabilities: caps,
          isConfigured: true,
          isCombo: true,
          comboId: combo.id,
          comboStrategy: combo.strategy || "priority",
          comboModels: memberModels,
          comboDescription: combo.description || undefined,
        });
      }
    });

    // 5. Dynamic Built-in Auto Combos (auto/best-coding, auto/best-reasoning, auto/best-free, etc.)
    const BUILTIN_AUTO_COMBOS = [
      {
        id: "auto/best-coding",
        name: "auto/best-coding",
        description: "Built-in auto routing: Best coding model selection across active providers",
      },
      {
        id: "auto/best-reasoning",
        name: "auto/best-reasoning",
        description:
          "Built-in auto routing: Best reasoning model selection across active providers",
      },
      {
        id: "auto/best-fast",
        name: "auto/best-fast",
        description:
          "Built-in auto routing: Lowest latency fast model selection across active providers",
      },
      {
        id: "auto/best-vision",
        name: "auto/best-vision",
        description:
          "Built-in auto routing: Multimodal and vision model selection across active providers",
      },
      {
        id: "auto/best-chat",
        name: "auto/best-chat",
        description: "Built-in auto routing: General chat model selection across active providers",
      },
      {
        id: "auto/best-coding-fast",
        name: "auto/best-coding-fast",
        description: "Built-in auto routing: Fast coding model selection across active providers",
      },
      {
        id: "auto/best-free",
        name: "auto/best-free",
        description:
          "Built-in auto routing: 100% strictly verified free models across active providers",
      },
      {
        id: "auto/best-chaos",
        name: "auto/best-chaos",
        description:
          "Built-in auto routing: Parallel multi-model dispatch to top stable candidates",
      },
      {
        id: "auto/coding:free",
        name: "auto/coding:free",
        description: "Built-in auto routing: Free coding models across active providers",
      },
      {
        id: "auto/reasoning:free",
        name: "auto/reasoning:free",
        description: "Built-in auto routing: Free reasoning models across active providers",
      },
    ];

    BUILTIN_AUTO_COMBOS.forEach((ac) => {
      if (!seenValues.has(ac.id)) {
        seenValues.add(ac.id);
        const caps = detectComboCapabilities(ac);
        pool.push({
          id: ac.id,
          name: ac.name,
          fullValue: ac.id,
          providerId: "combo",
          providerAlias: "combo",
          providerName: "Combos",
          capabilities: caps,
          isConfigured: true,
          isCombo: true,
          comboId: ac.id,
          comboStrategy: "auto",
          comboModels: [],
          comboDescription: ac.description,
        });
      }
    });

    return pool;
  }, [allProvidersMap, activeProviderIds, connections, customModels, syncedModels, combos]);

  // Strictly filter models for the selected tier and capability filters
  const filteredModels = useMemo(() => {
    return allCandidateModels
      .filter((model) => {
        // 1. Strict Tier Eligibility
        if (!isModelEligibleForTier(tier, model.capabilities)) {
          return false;
        }

        // 2. Configured Providers Only toggle
        if (showConfiguredOnly && !model.isConfigured) {
          return false;
        }

        // 3. Provider filter (left sidebar)
        if (selectedProviderFilter !== "all" && model.providerId !== selectedProviderFilter) {
          return false;
        }

        // 4. Capability Filter Chips (multi-select)
        if (!matchesCapabilityFilters(activeCapabilityFilters, model.capabilities, tier)) {
          return false;
        }

        // 5. Search Query Filter
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase().trim();
          const matchesName = model.name.toLowerCase().includes(q);
          const matchesId = model.id.toLowerCase().includes(q);
          const matchesFull = model.fullValue.toLowerCase().includes(q);
          const matchesProvider =
            model.providerName.toLowerCase().includes(q) ||
            model.providerAlias.toLowerCase().includes(q);
          const matchesDesc = model.comboDescription?.toLowerCase().includes(q);
          const matchesStrategy = model.comboStrategy?.toLowerCase().includes(q);
          const matchesTargets = model.comboModels?.some((m) => m.toLowerCase().includes(q));
          if (
            !matchesName &&
            !matchesId &&
            !matchesFull &&
            !matchesProvider &&
            !matchesDesc &&
            !matchesStrategy &&
            !matchesTargets
          ) {
            return false;
          }
        }

        return true;
      })
      .sort((a, b) => {
        if (sortOrder === "free-first") {
          if (a.capabilities.isFree && !b.capabilities.isFree) return -1;
          if (!a.capabilities.isFree && b.capabilities.isFree) return 1;
        } else if (sortOrder === "context-desc") {
          const ctxA = a.capabilities.contextLength || 0;
          const ctxB = b.capabilities.contextLength || 0;
          if (ctxA !== ctxB) return ctxB - ctxA;
        }
        return a.name.localeCompare(b.name);
      });
  }, [
    allCandidateModels,
    tier,
    showConfiguredOnly,
    selectedProviderFilter,
    activeCapabilityFilters,
    searchQuery,
    sortOrder,
  ]);

  // Distinct providers that have at least one eligible model
  const availableProviders = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; alias: string; count: number; isConfigured: boolean }
    >();

    allCandidateModels.forEach((m) => {
      if (isModelEligibleForTier(tier, m.capabilities)) {
        if (!showConfiguredOnly || m.isConfigured) {
          const existing = map.get(m.providerId);
          if (existing) {
            existing.count += 1;
          } else {
            map.set(m.providerId, {
              id: m.providerId,
              name: m.providerName,
              alias: m.providerAlias,
              count: 1,
              isConfigured: m.isConfigured,
            });
          }
        }
      }
    });

    return Array.from(map.values()).sort((a, b) => {
      if (a.id === "combo" && b.id !== "combo") return -1;
      if (a.id !== "combo" && b.id === "combo") return 1;
      if (a.isConfigured && !b.isConfigured) return -1;
      if (!a.isConfigured && b.isConfigured) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [allCandidateModels, tier, showConfiguredOnly]);

  const toggleModel = (model: TierSelectableModel) => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      if (isModelChecked(model)) {
        next.delete(model.fullValue);
        next.delete(model.id);
        next.delete(`combo/${model.id}`);
        next.delete(`${model.providerAlias}/${model.id}`);
        next.delete(`${model.providerId}/${model.id}`);
      } else {
        next.add(model.fullValue);
      }
      return next;
    });
  };

  const isModelChecked = (model: TierSelectableModel) => {
    return (
      localSelected.has(model.fullValue) ||
      localSelected.has(model.id) ||
      localSelected.has(`combo/${model.id}`) ||
      localSelected.has(`${model.providerAlias}/${model.id}`) ||
      localSelected.has(`${model.providerId}/${model.id}`)
    );
  };

  const handleSelectAllShown = () => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      filteredModels.forEach((m) => next.add(m.fullValue));
      return next;
    });
  };

  const handleDeselectAllShown = () => {
    setLocalSelected((prev) => {
      const next = new Set(prev);
      filteredModels.forEach((m) => {
        next.delete(m.fullValue);
        next.delete(m.id);
        next.delete(`combo/${m.id}`);
        next.delete(`${m.providerAlias}/${m.id}`);
        next.delete(`${m.providerId}/${m.id}`);
      });
      return next;
    });
  };

  const handleClearAll = () => {
    setLocalSelected(new Set());
  };

  const handleAddCustomModel = (e: React.FormEvent) => {
    e.preventDefault();
    const val = customInput.trim();
    if (!val) return;
    setLocalSelected((prev) => new Set(prev).add(val));
    setCustomInput("");
  };

  const handleConfirmSave = () => {
    onSave(Array.from(localSelected));
    onClose();
  };

  const colorStyle = getTierColorClass(tier);

  const footer = (
    <div className="flex items-center justify-between w-full pt-2 border-t border-border flex-wrap gap-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${colorStyle.badgeBg} ${colorStyle.badgeBorder} ${colorStyle.badgeText} border`}
        >
          {localSelected.size} {localSelected.size === 1 ? "Model" : "Models"} Selected
        </span>
        {localSelected.size > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            className="text-xs text-muted-foreground hover:text-foreground underline transition-colors"
          >
            Clear All
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirmSave}
          className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Apply Models to Tier
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">account_tree</span>
          <div>
            <div className="font-semibold text-sm leading-tight text-foreground">
              {tierTitle} — Provider-Aware Model Selector
            </div>
            {tierDescription && (
              <div className="text-xs text-muted-foreground font-normal">{tierDescription}</div>
            )}
          </div>
        </div>
      }
      size="xl"
      className="p-4! max-w-4xl"
      footer={footer}
    >
      {/* Search and Capability Filter Header */}
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-[16px]">
              search
            </span>
            <input
              type="text"
              placeholder={`Search ${tierTitle} models or providers...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-inner"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none whitespace-nowrap bg-muted/40 px-2.5 py-1.5 rounded-md border border-border">
            <input
              type="checkbox"
              checked={showConfiguredOnly}
              onChange={(e) => setShowConfiguredOnly(e.target.checked)}
              className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
            />
            <span>Active Providers Only</span>
          </label>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as any)}
            className="bg-muted/40 border border-border text-xs text-foreground rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            title="Sort models"
          >
            <option value="free-first">Sort: Free Models First</option>
            <option value="context-desc">Sort: Context Window (High to Low)</option>
            <option value="name-asc">Sort: Name (A to Z)</option>
          </select>
        </div>

        {/* Capability Filters (Multi-Select) */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs select-none">
          <span className="text-xs text-muted-foreground font-medium mr-1">Capabilities:</span>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("all")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
              activeCapabilityFilters.has("all")
                ? "bg-primary text-primary-foreground border-primary shadow-sm"
                : "bg-surface border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            All Tier Models
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("free")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("free")
                ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                : "bg-surface border-border text-emerald-400 hover:bg-emerald-500/10"
            }`}
          >
            <span>🎁 Free Models</span>
            {activeCapabilityFilters.has("free") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("apex")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("apex")
                ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                : "bg-surface border-border text-indigo-400 hover:bg-indigo-500/10"
            }`}
          >
            <span>🧠 Apex Reasoning</span>
            {activeCapabilityFilters.has("apex") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("resilient")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("resilient")
                ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                : "bg-surface border-border text-blue-400 hover:bg-blue-500/10"
            }`}
          >
            <span>🛡️ Resilient Execution</span>
            {activeCapabilityFilters.has("resilient") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("local")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("local")
                ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                : "bg-surface border-border text-emerald-400 hover:bg-emerald-500/10"
            }`}
          >
            <span>⚡ Local Engine</span>
            {activeCapabilityFilters.has("local") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("tools")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("tools")
                ? "bg-amber-600 text-white border-amber-600 shadow-sm"
                : "bg-surface border-border text-amber-400 hover:bg-amber-500/10"
            }`}
          >
            <span>⚙️ Tool Calling</span>
            {activeCapabilityFilters.has("tools") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => handleToggleCapabilityFilter("vision")}
            className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
              activeCapabilityFilters.has("vision")
                ? "bg-cyan-600 text-white border-cyan-600 shadow-sm"
                : "bg-surface border-border text-cyan-400 hover:bg-cyan-500/10"
            }`}
          >
            <span>👁️ Multimodal / Vision</span>
            {activeCapabilityFilters.has("vision") && (
              <span className="material-symbols-outlined text-[13px] leading-none">check</span>
            )}
          </button>
        </div>
      </div>

      {/* Main Container: Sidebar + Model Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 border border-border rounded-lg overflow-hidden bg-background">
        {/* Left Sidebar: Providers */}
        <div className="border-r border-border bg-muted/20 p-2 space-y-1 max-h-[420px] overflow-y-auto">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
            Providers ({availableProviders.length})
          </div>
          <button
            type="button"
            onClick={() => setSelectedProviderFilter("all")}
            className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between transition-colors ${
              selectedProviderFilter === "all"
                ? "bg-primary text-primary-foreground font-medium"
                : "text-foreground hover:bg-muted"
            }`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <span className="material-symbols-outlined text-[15px]">apps</span>
              All Providers
            </span>
            <span className="text-xs opacity-75 font-mono">
              {
                allCandidateModels.filter((m) => isModelEligibleForTier(tier, m.capabilities))
                  .length
              }
            </span>
          </button>

          {availableProviders.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedProviderFilter(p.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between transition-colors ${
                selectedProviderFilter === p.id
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-foreground hover:bg-muted"
              }`}
            >
              <span className="flex items-center gap-1.5 truncate min-w-0">
                {p.id === "combo" ? (
                  <span className="material-symbols-outlined text-[16px] text-purple-400 shrink-0">
                    layers
                  </span>
                ) : (
                  <ProviderIcon providerId={p.id} size={16} />
                )}
                <span className="truncate">{p.name}</span>
                {p.isConfigured && (
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
                    title="Active connection configured"
                  />
                )}
              </span>
              <span className="text-xs opacity-75 font-mono ml-1">{p.count}</span>
            </button>
          ))}
        </div>

        {/* Right Main Panel: Models */}
        <div className="md:col-span-3 p-3 flex flex-col max-h-[420px]">
          {/* Header controls for model list */}
          <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
            <span>
              Showing {filteredModels.length} eligible {tierTitle} models
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSelectAllShown}
                className="hover:text-primary transition-colors font-medium text-xs"
              >
                Select Shown
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={handleDeselectAllShown}
                className="hover:text-primary transition-colors font-medium text-xs"
              >
                Deselect Shown
              </button>
            </div>
          </div>

          {/* Model Card Grid */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {filteredModels.length === 0 ? (
              <div className="h-48 flex flex-col items-center justify-center text-center p-4 text-muted-foreground">
                <span className="material-symbols-outlined text-[32px] mb-1 text-muted-foreground/60">
                  filter_alt_off
                </span>
                <p className="text-xs font-medium">No models match the current filter.</p>
                <p className="text-xs text-muted-foreground/80 mt-1 max-w-sm">
                  {showConfiguredOnly
                    ? "Try unchecking 'Active Providers Only' or selecting 'All Providers'."
                    : "Only models strictly matching the tier capabilities are displayed."}
                </p>
              </div>
            ) : (
              filteredModels.map((model) => {
                const checked = isModelChecked(model);
                return (
                  <div
                    key={model.fullValue}
                    onClick={() => toggleModel(model)}
                    className={`flex items-start gap-2.5 p-2 rounded-md border text-xs cursor-pointer select-none transition-all ${
                      checked
                        ? "bg-primary/5 border-primary shadow-sm"
                        : "bg-surface hover:bg-muted/40 border-border"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {}} // Handled by parent div onClick
                      className="mt-0.5 rounded border-input text-primary focus:ring-primary h-4 w-4 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-foreground text-xs">{model.name}</span>
                        <span className="text-xs text-muted-foreground font-mono bg-muted/60 px-1.5 py-0.2 rounded border border-border">
                          {model.fullValue}
                        </span>
                        {model.capabilities.isFree && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            FREE
                          </span>
                        )}
                        {model.isCombo && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-xs font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">
                            <span className="material-symbols-outlined text-xs">layers</span>
                            Combo: {model.comboStrategy || "priority"}
                          </span>
                        )}
                        {model.isCombo && (
                          <a
                            href={`/dashboard/combos?highlight=${encodeURIComponent(model.comboId || model.id)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-xs font-semibold bg-purple-500/10 text-purple-300 hover:text-purple-100 hover:bg-purple-500/25 border border-purple-500/30 transition-colors ml-auto"
                            title="Open combo in Dashboard"
                          >
                            <span>Open Combo</span>
                            <span className="material-symbols-outlined text-[12px]">
                              open_in_new
                            </span>
                          </a>
                        )}
                      </div>

                      {model.isCombo && model.comboModels && model.comboModels.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                          Targets: {model.comboModels.slice(0, 4).join(", ")}
                          {model.comboModels.length > 4
                            ? ` +${model.comboModels.length - 4} more`
                            : ""}
                        </div>
                      )}

                      {model.isCombo && model.comboDescription && (
                        <div className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-1 italic">
                          {model.comboDescription}
                        </div>
                      )}

                      {/* Capabilities Badges */}
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          {model.isCombo ? (
                            <span className="material-symbols-outlined text-[13px] text-purple-400">
                              layers
                            </span>
                          ) : (
                            <ProviderIcon providerId={model.providerId} size={12} />
                          )}
                          {model.providerName}
                        </span>

                        {model.capabilities.isApexReasoning && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            🧠 Apex Reasoning
                          </span>
                        )}

                        {model.capabilities.isResilient && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            🛡️ Resilient
                          </span>
                        )}

                        {model.capabilities.isLocalEngine && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            ⚡ Local Engine
                          </span>
                        )}

                        {model.capabilities.hasToolCalling && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            ⚙️ Tools
                          </span>
                        )}

                        {model.capabilities.hasVision && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            👁️ Vision
                          </span>
                        )}

                        {model.capabilities.contextLength && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-xs text-muted-foreground bg-muted/40 font-mono">
                            {Math.round(model.capabilities.contextLength / 1000)}k ctx
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Custom Bespoke Model Option */}
          <form
            onSubmit={handleAddCustomModel}
            className="pt-2.5 mt-2 border-t border-border flex items-center gap-2"
          >
            <input
              type="text"
              placeholder="Add bespoke/off-catalog model (e.g. custom/my-model)..."
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              className="flex-1 px-2.5 py-1 text-xs bg-surface border border-border rounded-md text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!customInput.trim()}
              className="px-2.5 py-1 text-xs font-medium rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
            >
              Add Custom
            </button>
          </form>
        </div>
      </div>
    </Modal>
  );
}
