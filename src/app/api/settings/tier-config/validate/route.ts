import { NextResponse } from "next/server";
import { z } from "zod";
import { loadTierConfig } from "@/lib/db/tierConfig";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels";
import { spbRuntimeConfigSchema } from "@omniroute/open-sse/services/tierConfig";

const ValidateSchema = z.object({
  profile: z.string().min(1).optional(),
  spbEnabled: z.boolean().optional(),
  tierModels: z
    .object({
      apex: z.array(z.string()).min(1, "Apex tier must have at least one model"),
      resilient: z.array(z.string()).min(1, "Resilient tier must have at least one model"),
      local: z.array(z.string()).min(1, "Local tier must have at least one model"),
    })
    .optional(),
  maxLedgerItems: z.number().int().min(1).max(50).default(8).optional(),
  recoveryIntervalMs: z.number().int().min(10000).max(3600000).default(60000).optional(),
  spbConfig: spbRuntimeConfigSchema.optional(),
});

function validateModelIds(models: string[]): string[] {
  const known = new Set([
    ...Object.keys(PROVIDER_ID_TO_ALIAS),
    ...Object.values(PROVIDER_ID_TO_ALIAS),
  ]);
  return models.filter((m) => {
    if (!m) return true;
    if (known.has(m)) return false;
    // Allow models with provider prefixes e.g. "openai/gpt-4o" or direct model names
    const parts = m.split("/");
    const bareModel = parts.length > 1 ? parts.slice(1).join("/") : m;
    const provider = parts.length > 1 ? parts[0] : "";
    if (known.has(bareModel) || known.has(provider)) return false;
    // Common providers and standard IDs
    const commonPatterns = /^(gpt-|claude-|gemini-|llama|qwen|deepseek|mistral|o1|o3)/i;
    return !commonPatterns.test(bareModel);
  });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const rawBody = await request.json().catch(() => null);
  const parsed = ValidateSchema.safeParse(rawBody);

  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const formattedErrors: string[] = [];
    for (const [field, errs] of Object.entries(fieldErrors)) {
      if (errs && errs.length > 0) {
        formattedErrors.push(`${field}: ${errs.join(", ")}`);
      }
    }
    return NextResponse.json(
      {
        valid: false,
        errors: formattedErrors,
        fieldErrors,
      },
      { status: 400 }
    );
  }

  const profile = parsed.data.profile || "default";
  const profileKey = profile === "default" || profile === "spb" ? "tier_config" : profile;
  const currentConfig = loadTierConfig(profileKey);

  const merged = {
    ...currentConfig,
    ...parsed.data,
    tierModels: parsed.data.tierModels ??
      currentConfig.tierModels ?? {
        apex: [],
        resilient: [],
        local: [],
      },
  };

  const allModels = [
    ...(merged.tierModels.apex || []),
    ...(merged.tierModels.resilient || []),
    ...(merged.tierModels.local || []),
  ];

  const unknown = validateModelIds(allModels);
  if (unknown.length > 0) {
    return NextResponse.json(
      {
        valid: false,
        errors: [`Unknown model IDs: ${unknown.join(", ")}`],
        fieldErrors: { tierModels: [`Unknown model IDs: ${unknown.join(", ")}`] },
      },
      { status: 400 }
    );
  }

  // Preview effective tier assignment
  const preview = {
    code: merged.tierModels.apex?.[0] || merged.tierModels.resilient?.[0] || "auto",
    reasoning: merged.tierModels.apex?.[0] || "auto",
    creative: merged.tierModels.resilient?.[0] || merged.tierModels.apex?.[0] || "auto",
    simple: merged.tierModels.local?.[0] || merged.tierModels.resilient?.[0] || "auto",
    tierModels: merged.tierModels,
  };

  return NextResponse.json({
    valid: true,
    errors: [],
    preview,
    config: merged,
  });
}
