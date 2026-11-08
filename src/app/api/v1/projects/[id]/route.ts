import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getProject,
  updateProjectMeta,
  deleteProject,
  archiveProject,
  reactivateProject,
} from "@/lib/db/projectRegistry";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/v1/projects/[id] — Retrieve project details
export async function GET(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true, project });
}

// PATCH /api/v1/projects/[id] — Update project metadata
export async function PATCH(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const existing = getProject(id);
  if (!existing) {
    return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const updated = updateProjectMeta(id, body);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const project = getProject(id);
    return NextResponse.json({ success: true, project });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update project",
      },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/projects/[id] — Remove project from registry
export async function DELETE(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const deleted = deleteProject(id);
  if (!deleted) {
    return NextResponse.json(
      { success: false, error: "Project not found or already deleted" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, message: "Project deleted successfully" });
}

// POST /api/v1/projects/[id]/archive — Toggle archive / active status
// Accepts an optional body: { action: "archive" | "unarchive" | "reactivate" }
export async function POST(request: Request, context: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await context.params;
  const existing = getProject(id);
  if (!existing) {
    return NextResponse.json({ success: false, error: "Project not found" }, { status: 404 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    const action = body?.action || (existing.status === "archiving" ? "reactivate" : "archive");

    let updated: ReturnType<typeof archiveProject> = null;
    if (action === "reactivate" || action === "unarchive") {
      updated = reactivateProject(id);
    } else {
      updated = archiveProject(id);
    }

    return NextResponse.json({
      success: true,
      project: updated,
      message: `Project ${action === "reactivate" || action === "unarchive" ? "reactivated" : "archived"} successfully`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to toggle archive status",
      },
      { status: 500 }
    );
  }
}
