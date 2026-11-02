import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { calculateProjectAnalytics } from "@omniroute/open-sse/services/projectAnalytics.ts";
import { getProject } from "@/lib/db/projectRegistry";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// POST /api/v1/projects/[id]/analytics — On-demand calculate and update project analytics
export async function POST(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
  }

  try {
    const analytics = await calculateProjectAnalytics(id);
    if (!analytics) {
      return NextResponse.json(
        { success: false, error: "Failed to calculate analytics" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      analytics,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Error computing analytics",
      },
      { status: 500 }
    );
  }
}
