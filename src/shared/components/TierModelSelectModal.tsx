"use client";

import React, { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import {
  type SpbTierKey,
  type CapabilityFilterKey,
  type TierSelectableModel,
  detectModelCapabilities,
  isModelEligibleForTier,
  matchesCapabilityFilter,
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
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCapabilityFilter, setActiveCapabilityFilter] = useState<CapabilityFilterKey>("all");
  const [selectedProviderFilter, setSelectedProviderFilter] = useState<string>("all");
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(true);
  const [customInput, setCustomInput] = useState("");

  // Render-time state adjustment when modal opens (avoids cascading render warning)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setLocalSelected(new Set(selectedModels));
      setSearchQuery("");
      setActiveCapabilityFilter("all");
      setSelectedProviderFilter("all");
      setCustomInput("");
    }
  }

  // Fetch connections and custom models
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const loadData = async () => {
      try {
        const [connRes, customRes] = await Promise.all([
          fetch("/api/providers").catch(() => null),
          fetch("/api/provider-models").catch(() => null),
        ]);

        if (!cancelled && connRes?.ok) {
          const connData = await connRes.json();
          setConnections(connData.connections || []);
        }

        if (!cancelled && customRes?.ok) {
          const customData = await customRes.json();
          setCustomModels(customData.models || {});
        }
      } catch (err) {
        console.error("Failed to load providers or models for tier selector:", err);
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
    });

    return pool;
  }, [allProvidersMap, activeProviderIds, connections, customModels]);

  // Strictly filter models for the selected tier and capability filters
  const filteredModels = useMemo(() => {
    return allCandidateModels.filter((model) => {
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

      // 4. Capability Filter Chip
      if (!matchesCapabilityFilter(activeCapabilityFilter, model.capabilities, tier)) {
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
        if (!matchesName && !matchesId && !matchesFull && !matchesProvider) {
          return false;
        }
      }

      return true;
    });
  }, [
    allCandidateModels,
    tier,
    showConfiguredOnly,
    selectedProviderFilter,
    activeCapabilityFilter,
    searchQuery,
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
              <div className="text-[11px] text-muted-foreground font-normal">{tierDescription}</div>
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
        </div>

        {/* Capability Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs select-none">
          <span className="text-[11px] text-muted-foreground font-medium mr-1">Capabilities:</span>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("all")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "all"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-surface border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            All Tier Models
          </button>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("apex")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "apex"
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-surface border-border text-indigo-400 hover:bg-indigo-500/10"
            }`}
          >
            🧠 Apex Reasoning
          </button>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("resilient")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "resilient"
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-surface border-border text-blue-400 hover:bg-blue-500/10"
            }`}
          >
            🛡️ Resilient Execution
          </button>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("local")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "local"
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-surface border-border text-emerald-400 hover:bg-emerald-500/10"
            }`}
          >
            ⚡ Local Engine
          </button>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("tools")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "tools"
                ? "bg-amber-600 text-white border-amber-600"
                : "bg-surface border-border text-amber-400 hover:bg-amber-500/10"
            }`}
          >
            ⚙️ Tool Calling
          </button>
          <button
            type="button"
            onClick={() => setActiveCapabilityFilter("vision")}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
              activeCapabilityFilter === "vision"
                ? "bg-cyan-600 text-white border-cyan-600"
                : "bg-surface border-border text-cyan-400 hover:bg-cyan-500/10"
            }`}
          >
            👁️ Multimodal / Vision
          </button>
        </div>
      </div>

      {/* Main Container: Sidebar + Model Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 border border-border rounded-lg overflow-hidden bg-background">
        {/* Left Sidebar: Providers */}
        <div className="border-r border-border bg-muted/20 p-2 space-y-1 max-h-[420px] overflow-y-auto">
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-2 py-1">
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
            <span className="text-[10px] opacity-75 font-mono">
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
                <ProviderIcon providerId={p.id} size={16} />
                <span className="truncate">{p.name}</span>
                {p.isConfigured && (
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
                    title="Active connection configured"
                  />
                )}
              </span>
              <span className="text-[10px] opacity-75 font-mono ml-1">{p.count}</span>
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
                className="hover:text-primary transition-colors font-medium text-[11px]"
              >
                Select Shown
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={handleDeselectAllShown}
                className="hover:text-primary transition-colors font-medium text-[11px]"
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
                <p className="text-[11px] text-muted-foreground/80 mt-1 max-w-sm">
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
                        <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-1.5 py-0.2 rounded border border-border">
                          {model.fullValue}
                        </span>
                      </div>

                      {/* Capabilities Badges */}
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                          <ProviderIcon providerId={model.providerId} size={12} />
                          {model.providerName}
                        </span>

                        {model.capabilities.isApexReasoning && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            🧠 Apex Reasoning
                          </span>
                        )}

                        {model.capabilities.isResilient && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            🛡️ Resilient
                          </span>
                        )}

                        {model.capabilities.isLocalEngine && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            ⚡ Local Engine
                          </span>
                        )}

                        {model.capabilities.hasToolCalling && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            ⚙️ Tools
                          </span>
                        )}

                        {model.capabilities.hasVision && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            👁️ Vision
                          </span>
                        )}

                        {model.capabilities.contextLength && (
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] text-muted-foreground bg-muted/40 font-mono">
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
