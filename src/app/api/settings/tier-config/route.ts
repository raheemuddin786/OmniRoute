import { NextResponse } from "next/server";
import { z } from "zod";
import { loadTierConfig, saveTierConfig } from "@/lib/db/tierConfig";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { setTierConfig } from "@omniroute/open-sse/services/tierResolver";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { setFeatureFlagOverride } from "@/lib/db/featureFlags";

/**
 * Settings route for routing-tier and SPB-IR configurations (#7818, SPB-IR).
 *
 * `classifyTier()` (`open-sse/services/tierResolver.ts`) already honors
 * `TierConfig.providerOverrides` — an array of `{ provider, tier }` keyed by the
 * provider **id string**. This route manages both individual provider tier overrides
 * and global SPB-IR parameters (spbEnabled, tierWeights, tierModels, cacheThreshold, fallbackTimeout).
 * It persists changes in `tier_config` (and synchronizes the `SPB_ENABLED` feature flag),
 * and busts the in-process routing cache via `setTierConfig()` so changes take effect
 * on the very next request without a restart.
 */

const tierSettingsPutSchema = z
  .object({
    provider: z.string().min(1).optional(),
    tier: z.enum(["free", "cheap", "premium"]).nullable().optional(),
    spbEnabled: z.boolean().optional(),
    tierWeights: z
      .object({
        apex: z.number().min(0).max(1),
        resilient: z.number().min(0).max(1),
        local: z.number().min(0).max(1),
      })
      .optional(),
    tierModels: z
      .object({
        apex: z.array(z.string().min(1)).default([]),
        resilient: z.array(z.string().min(1)).default([]),
        local: z.array(z.string().min(1)).default([]),
      })
      .optional(),
    cacheThreshold: z.number().min(0).optional(),
    fallbackTimeout: z.number().min(0).optional(),
    providerOverrides: z
      .array(
        z.object({
          provider: z.string().min(1),
          tier: z.enum(["free", "cheap", "premium"]),
        })
      )
      .optional(),
  })
  .refine(
    (data) =>
      data.provider !== undefined ||
      data.spbEnabled !== undefined ||
      data.tierWeights !== undefined ||
      data.tierModels !== undefined ||
      data.cacheThreshold !== undefined ||
      data.fallbackTimeout !== undefined ||
      data.providerOverrides !== undefined,
    { message: "At least one configuration property must be provided" }
  );

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const config = loadTierConfig();
  const spbFlagActive = isFeatureFlagEnabled("SPB_ENABLED");
  return NextResponse.json({
    ...config,
    tierModels: config.tierModels ?? { apex: [], resilient: [], local: [] },
    spbEnabled: config.spbEnabled || spbFlagActive,
  });
}

export async function PUT(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const rawBody = await request.json().catch(() => null);
  const parsed = tierSettingsPutSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(buildErrorBody(400, "Invalid tier override payload"), {
      status: 400,
    });
  }

  const {
    provider,
    tier,
    spbEnabled,
    tierWeights,
    tierModels,
    cacheThreshold,
    fallbackTimeout,
    providerOverrides,
  } = parsed.data;
  const config = loadTierConfig();
  let nextOverrides = [...config.providerOverrides];

  if (providerOverrides !== undefined) {
    nextOverrides = providerOverrides;
  } else if (provider !== undefined && tier !== undefined) {
    nextOverrides = nextOverrides.filter(
      (o) => o.provider.toLowerCase() !== provider.toLowerCase()
    );
    if (tier !== null) {
      nextOverrides.push({ provider, tier });
    }
  }

  if (spbEnabled !== undefined) {
    try {
      setFeatureFlagOverride("SPB_ENABLED", spbEnabled ? "true" : "false");
    } catch (err) {
      console.warn("[TierConfig Route] Failed to sync SPB_ENABLED feature flag:", err);
    }
  }

  const nextConfig = {
    ...config,
    providerOverrides: nextOverrides,
    spbEnabled: spbEnabled ?? config.spbEnabled,
    tierWeights: tierWeights ?? config.tierWeights,
    tierModels: tierModels ?? config.tierModels,
    cacheThreshold: cacheThreshold ?? config.cacheThreshold,
    fallbackTimeout: fallbackTimeout ?? config.fallbackTimeout,
  };

  saveTierConfig(nextConfig);
  setTierConfig(nextConfig); // bust the in-process routing cache immediately

  return NextResponse.json(nextConfig);
}
