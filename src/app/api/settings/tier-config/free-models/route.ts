import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { discoverAvailableFreeTierModels } from "@omniroute/open-sse/services/spbFreeTierAutoConfig";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const models = discoverAvailableFreeTierModels();
  return NextResponse.json({
    models,
    total: models.length,
    byTier: {
      apex: models.filter((m) => m.tier === "apex"),
      resilient: models.filter((m) => m.tier === "resilient"),
      local: models.filter((m) => m.tier === "local"),
    },
  });
}
