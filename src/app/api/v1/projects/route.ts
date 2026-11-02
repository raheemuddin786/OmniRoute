import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listProjects, insertProject, getProjectByBasePath } from "@/lib/db/projectRegistry";
import { scanProjectDirectory, autoDiscoverWorkspaces } from "@/lib/projectScanner";
import { getDbInstance } from "@/lib/db/core";
import { randomUUID } from "crypto";

// Auto-seed current project and auto-derive workspaces from request logs and worktrees
function ensureWorkspacesDerived() {
  const db = getDbInstance();
  const logSnippets: string[] = [];

  try {
    const logs = db
      .prepare(
        `SELECT request_summary, session_tag, model
         FROM call_logs
         ORDER BY id DESC
         LIMIT 50`
      )
      .all() as Array<{ request_summary?: string; session_tag?: string }>;

    for (const row of logs) {
      if (row.request_summary) logSnippets.push(row.request_summary);
      if (row.session_tag) logSnippets.push(row.session_tag);
    }
  } catch {
    // Graceful fallback if call_logs table doesn't exist yet
  }

  const discovered = autoDiscoverWorkspaces(logSnippets);
  for (const scan of discovered) {
    const existing = getProjectByBasePath(scan.basePath);
    if (!existing) {
      const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      insertProject(
        id,
        scan.name,
        scan.basePath,
        scan.description,
        scan.techStack,
        scan.cloudStack,
        scan.features,
        scan.filesCount,
        scan.docsCount,
        "active",
        scan.provenance,
        scan.memoryLocations
      );
    }
  }
}

// GET /api/v1/projects — List all connected projects
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    ensureWorkspacesDerived();
    const projects = listProjects();
    return NextResponse.json({
      success: true,
      projects,
      total: projects.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list projects" },
      { status: 500 }
    );
  }
}

// POST /api/v1/projects — Register a new project or scan an existing directory
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const basePath = typeof body.basePath === "string" ? body.basePath.trim() : "";
    if (!basePath) {
      return NextResponse.json({ success: false, error: "basePath is required" }, { status: 400 });
    }

    const existing = getProjectByBasePath(basePath);
    if (existing) {
      return NextResponse.json({
        success: true,
        project: existing,
        message: "Project already registered",
      });
    }

    // Scan directory
    const provenance = body.provenance === "manual" ? "manual" : "derived";
    const scan = scanProjectDirectory(basePath, provenance);
    const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const project = insertProject(
      id,
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : scan.name,
      basePath,
      typeof body.description === "string" ? body.description.trim() : scan.description,
      Array.isArray(body.techStack) ? body.techStack : scan.techStack,
      Array.isArray(body.cloudStack) ? body.cloudStack : scan.cloudStack,
      Array.isArray(body.features) ? body.features : scan.features,
      typeof body.filesCount === "number" ? body.filesCount : scan.filesCount,
      typeof body.docsCount === "number" ? body.docsCount : scan.docsCount,
      "active",
      provenance,
      Array.isArray(body.memoryLocations) ? body.memoryLocations : scan.memoryLocations
    );

    return NextResponse.json({
      success: true,
      project,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to register project",
      },
      { status: 500 }
    );
  }
}
