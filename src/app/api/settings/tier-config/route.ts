import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadTierConfig,
  saveTierConfig,
  listTierConfigProfiles,
  deleteTierConfigProfile,
} from "@/lib/db/tierConfig";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  setTierConfig,
  setNamedTierConfig,
  deleteNamedTierConfig,
} from "@omniroute/open-sse/services/tierResolver";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { setFeatureFlagOverride } from "@/lib/db/featureFlags";
import { spbRuntimeConfigSchema } from "@omniroute/open-sse/services/tierConfig";

/**
 * Settings route for routing-tier and SPB-IR configurations (#7818, SPB-IR).
 *
 * `classifyTier()` (`open-sse/services/tierResolver.ts`) already honors
 * `TierConfig.providerOverrides` — an array of `{ provider, tier }` keyed by the
 * provider **id string**. This route manages both individual provider tier overrides
 * and global SPB-IR parameters (spbEnabled, tierWeights, tierModels, cacheThreshold, fallbackTimeout, spbConfig).
 * It persists changes in `tier_config` (and synchronizes the `SPB_ENABLED` feature flag),
 * and busts the in-process routing cache via `setTierConfig()` so changes take effect
 * on the very next request without a restart.
 */

const tierSettingsPutSchema = z
  .object({
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    tier: z.enum(["free", "cheap", "premium"]).nullable().optional(),
    spbEnabled: z.boolean().optional(),
    onlyFreeTierModels: z.boolean().optional(),
    tierModes: z
      .object({
        apex: z.enum(["free", "user", "both"]).optional(),
        resilient: z.enum(["free", "user", "both"]).optional(),
        local: z.enum(["free", "user", "both"]).optional(),
      })
      .optional(),
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
    tierProviders: z
      .object({
        apex: z.array(z.string().min(1)).default([]),
        resilient: z.array(z.string().min(1)).default([]),
        local: z.array(z.string().min(1)).default([]),
      })
      .optional(),
    cacheThreshold: z.number().min(0).optional(),
    fallbackTimeout: z.number().min(0).optional(),
    spbConfig: spbRuntimeConfigSchema.optional(),
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
      data.onlyFreeTierModels !== undefined ||
      data.tierModes !== undefined ||
      data.tierWeights !== undefined ||
      data.tierModels !== undefined ||
      data.tierProviders !== undefined ||
      data.cacheThreshold !== undefined ||
      data.fallbackTimeout !== undefined ||
      data.spbConfig !== undefined ||
      data.providerOverrides !== undefined,
    { message: "At least one configuration property must be provided" }
  );

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const profile = url.searchParams.get("profile") || "default";
  const listProfiles = url.searchParams.get("listProfiles") === "true";

  if (listProfiles) {
    const profiles = listTierConfigProfiles();
    return NextResponse.json({ profiles });
  }

  const profileKey = profile === "default" || profile === "spb" ? "tier_config" : profile;
  const config = loadTierConfig(profileKey);
  const spbFlagActive = isFeatureFlagEnabled("SPB_ENABLED");
  return NextResponse.json({
    ...config,
    profile,
    profiles: listTierConfigProfiles(),
    tierModels: config.tierModels ?? { apex: [], resilient: [], local: [] },
    tierProviders: config.tierProviders ?? { apex: [], resilient: [], local: [] },
    tierModes: config.tierModes ?? { apex: "both", resilient: "both", local: "both" },
    onlyFreeTierModels: config.onlyFreeTierModels ?? false,
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
    profile,
    provider,
    tier,
    spbEnabled,
    onlyFreeTierModels,
    tierModes,
    tierWeights,
    tierModels,
    tierProviders,
    cacheThreshold,
    fallbackTimeout,
    spbConfig,
    providerOverrides,
  } = parsed.data;
  const url = new URL(request.url);
  const targetProfile = profile || url.searchParams.get("profile") || "default";
  const profileKey =
    targetProfile === "default" || targetProfile === "spb" ? "tier_config" : targetProfile;
  const config = loadTierConfig(profileKey);
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
    onlyFreeTierModels: onlyFreeTierModels ?? config.onlyFreeTierModels ?? false,
    tierModes: {
      ...(config.tierModes ?? { apex: "both", resilient: "both", local: "both" }),
      ...(tierModes ?? {}),
    },
    tierWeights: tierWeights ?? config.tierWeights,
    tierModels: tierModels ?? config.tierModels,
    tierProviders: tierProviders !== undefined ? tierProviders : config.tierProviders,
    cacheThreshold: cacheThreshold ?? config.cacheThreshold,
    fallbackTimeout: fallbackTimeout ?? config.fallbackTimeout,
    spbConfig: spbConfig !== undefined ? spbConfig : config.spbConfig,
  };

  saveTierConfig(nextConfig, profileKey);
  if (profileKey === "tier_config") {
    setTierConfig(nextConfig); // bust default in-process routing cache immediately
  } else {
    setNamedTierConfig(targetProfile, nextConfig);
  }

  return NextResponse.json({ ...nextConfig, profile: targetProfile });
}

export async function DELETE(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const profile = url.searchParams.get("profile");

  if (!profile || profile === "default" || profile === "spb") {
    return NextResponse.json(buildErrorBody(400, "Cannot delete default SPB profile"), {
      status: 400,
    });
  }

  const success = deleteTierConfigProfile(profile);
  deleteNamedTierConfig(profile);

  return NextResponse.json({
    success,
    deletedProfile: profile,
    profiles: listTierConfigProfiles(),
  });
}
