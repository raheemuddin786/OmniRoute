import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { generateProjectBrief } from "@omniroute/open-sse/services/projectAnalytics.ts";
import { getProject } from "@/lib/db/projectRegistry";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// POST /api/v1/projects/[id]/brief — On-demand executive brief generation
export async function POST(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
  }

  try {
    const brief = await generateProjectBrief(id);
    if (!brief) {
      return NextResponse.json(
        { success: false, error: "Failed to generate brief" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      brief,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Error generating brief" },
      { status: 500 }
    );
  }
}
