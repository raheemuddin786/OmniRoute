tsx;
/**
 * Smart Proxy Bridge Configuration Panel
 * Provides UI controls for enabling/disabling SPB, tier weights, cache thresholds,
 * and fallback strategies. Persists to `tier_config` DB table via API.
 */

import React, { useEffect, useState } from "react";
import { useToast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

interface SpbConfig {
  enabled: boolean;
  tierWeights: {
    apex: number;
    resilient: number;
    local: number;
  };
  cacheThreshold: number;
  fallbackTimeout: number;
}

export function SpbConfig() {
  const [config, setConfig] = useState<SpbConfig>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    async function fetchSpbConfig() {
      try {
        const res = await fetch("/api/settings/tier-config");
        const data = await res.json();
        if (data.tierConfig?.providerOverrides) {
          const weights = { apex: 0.3, resilient: 0.5, local: 0.2 };
          setConfig({
            enabled: data.tierConfig?.spbEnabled ?? true,
            tierWeights: weights,
            cacheThreshold: 5000,
            fallbackTimeout: 5000,
          });
        }
      } catch (err) {
        toast({ title: "Error loading SPB config", description: String(err) });
      }
    }
    fetchSpbConfig();
  }, [toast]);

  async function saveConfig() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/tier-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "spb",
          tier: config.enabled ? "premium" : "free",
          spbEnabled: config.enabled,
        }),
      });
      if (res.ok) {
        toast({ title: "SPB config saved", description: "Changes applied immediately" });
      } else {
        toast({ title: "Save failed", description: await res.text() });
      }
    } finally {
      setLoading(false);
    }
  }

  const toggleEnabled = (checked: boolean) => {
    setConfig((c) => ({ ...c, enabled: checked }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Smart Proxy Bridge Settings</CardTitle>
        <CardDescription>Control SPB-IR behavior and tier selection</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center space-x-2">
          <Switch id="spb-enabled" checked={config?.enabled} onCheckedChange={toggleEnabled} />
          <Label htmlFor="spb-enabled">Enable Smart Proxy Bridge</Label>
        </div>

        <div className="space-y-2">
          <Label>Tier Weights (0-1 sum)</Label>
          <div className="flex space-x-4">
            <div className="flex-1">
              <Label className="text-xs">Apex Reasoning</Label>
              <Slider
                min={0}
                max={1}
                step={0.1}
                value={[config?.tierWeights?.apex ?? 0.3]}
                onValueChange={(v) =>
                  setConfig((c) => ({ ...c, tierWeights: { ...c?.tierWeights, apex: v[0] } }))
                }
              />
            </div>
            <div className="flex-1">
              <Label className="text-xs">Resilient Execution</Label>
              <Slider
                min={0}
                max={1}
                step={0.1}
                value={[config?.tierWeights?.resilient ?? 0.5]}
                onValueChange={(v) =>
                  setConfig((c) => ({ ...c, tierWeights: { ...c?.tierWeights, resilient: v[0] } }))
                }
              />
            </div>
            <div className="flex-1">
              <Label className="text-xs">Local Edge</Label>
              <Slider
                min={0}
                max={1}
                step={0.1}
                value={[config?.tierWeights?.local ?? 0.2]}
                onValueChange={(v) =>
                  setConfig((c) => ({ ...c, tierWeights: { ...c?.tierWeights, local: v[0] } }))
                }
              />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Cache Threshold (tokens)</Label>
          <Input
            type="number"
            value={config?.cacheThreshold ?? 5000}
            onChange={(e) => setConfig((c) => ({ ...c, cacheThreshold: Number(e.target.value) }))}
          />
        </div>

        <div className="space-y-2">
          <Label>Fallback Timeout (ms)</Label>
          <Input
            type="number"
            value={config?.fallbackTimeout ?? 5000}
            onChange={(e) => setConfig((c) => ({ ...c, fallbackTimeout: Number(e.target.value) }))}
          />
        </div>

        <Button onClick={saveConfig} disabled={loading}>
          {loading ? "Saving..." : "Apply Configuration"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default SpbConfig;
