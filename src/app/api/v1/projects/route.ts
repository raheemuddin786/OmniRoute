import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  listProjects,
  insertProject,
  getProjectByBasePath,
  deleteProject,
  type ProjectRegistry,
} from "@/lib/db/projectRegistry";
import {
  scanProjectDirectory,
  autoDiscoverWorkspaces,
  isValidWorkspaceRoot,
} from "@/lib/projectScanner";
import { getDbInstance } from "@/lib/db/core";
import { randomUUID } from "crypto";

// Auto-seed current project and auto-derive workspaces from request logs and worktrees
export function ensureWorkspacesDerived() {
  const db = getDbInstance();
  const logSnippets: string[] = [];

  // Prune any legacy or invalid entries that are not genuine workspace roots (e.g. ~/.nvm/... or system dirs)
  try {
    const existingProjects = listProjects();
    for (const proj of existingProjects) {
      if (!isValidWorkspaceRoot(proj.basePath)) {
        deleteProject(proj.id);
      }
    }
  } catch {
    // Graceful fallback
  }

  // 1. Direct workspace roots already observed in call_logs (migration 219)
  try {
    const tableInfo = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name?: string }>;
    const hasWorkspaceCol = tableInfo.some((r) => r.name === "workspace_root");
    const hasProjectCol = tableInfo.some((r) => r.name === "project_id");
    if (hasWorkspaceCol) {
      const distinctRoots = db
        .prepare(
          `SELECT DISTINCT workspace_root
           FROM call_logs
           WHERE workspace_root IS NOT NULL AND length(trim(workspace_root)) > 0
           LIMIT 100`
        )
        .all() as Array<{ workspace_root: string }>;

      for (const row of distinctRoots) {
        const rootPath = row.workspace_root?.trim();
        if (rootPath && isValidWorkspaceRoot(rootPath)) {
          let project = getProjectByBasePath(rootPath);
          if (!project) {
            const scan = scanProjectDirectory(rootPath, "derived");
            const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
            project = insertProject(
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

          // Backfill any call_logs rows that recorded this workspace_root before the
          // project was inserted or when project_id was NULL.
          if (project && hasProjectCol) {
            try {
              db.prepare(
                `UPDATE call_logs
                 SET project_id = ?
                 WHERE workspace_root = ? AND (project_id IS NULL OR project_id = '')`
              ).run(project.id, rootPath);
            } catch {
              // Best-effort backfill
            }
          }
        }
      }
    }
  } catch {
    // Graceful fallback if call_logs schema or query fails
  }

  // 2. Discover candidate workspaces from unstructured log snippets, current working directory, and worktrees
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
    if (!isValidWorkspaceRoot(scan.basePath)) continue;
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
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const validStatuses: ProjectRegistry["status"][] = ["active", "inactive", "archiving"];
    const status =
      statusParam && validStatuses.includes(statusParam as ProjectRegistry["status"])
        ? (statusParam as ProjectRegistry["status"])
        : undefined;

    ensureWorkspacesDerived();
    const projects = listProjects(status);
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

// POST /api/v1/projects/refresh — Manually trigger workspace auto-discovery and
// backfill of call_logs.project_id for any rows left dangling after a new
// project is registered. Used by the dashboard refresh button.
export async function POST_REFRESH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    ensureWorkspacesDerived();

    const db = getDbInstance();
    const tableInfo = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name?: string }>;
    const hasProjectCol = tableInfo.some((r) => r.name === "project_id");

    let backfilled = 0;
    let totalLinked = 0;
    if (hasProjectCol) {
      const rows = db
        .prepare(
          `SELECT DISTINCT workspace_root
           FROM call_logs
           WHERE workspace_root IS NOT NULL AND length(trim(workspace_root)) > 0
           LIMIT 200`
        )
        .all() as Array<{ workspace_root: string }>;

      for (const row of rows) {
        const rootPath = row.workspace_root?.trim();
        if (!rootPath) continue;
        const project = getProjectByBasePath(rootPath);
        if (project) {
          const result = db
            .prepare(
              `UPDATE call_logs
               SET project_id = ?
               WHERE workspace_root = ? AND (project_id IS NULL OR project_id = '')`
            )
            .run(project.id, rootPath);
          backfilled += result?.changes ?? 0;
        }
      }

      const linked = db
        .prepare(
          `SELECT COUNT(*) AS c FROM call_logs WHERE project_id IS NOT NULL AND length(trim(project_id)) > 0`
        )
        .get() as { c?: number };
      totalLinked = linked?.c ?? 0;
    }

    const projects = listProjects();
    return NextResponse.json({
      success: true,
      projects,
      total: projects.length,
      backfilled,
      totalLinked,
      message: `Workspace discovery complete; ${backfilled} call_logs rows backfilled, ${totalLinked} linked to a project`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to refresh projects",
      },
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
