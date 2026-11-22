/**
 * lib/usage/workspaceLinker.ts — Shared workspace → project resolution.
 *
 * Extracted from src/lib/usage/callLogs.ts (#13130 / migration 220) so the
 * request-time auto-registration path and the dashboard refresh path share one
 * implementation. Both paths previously duplicated the same ~40-line block,
 * and the two copies drifted: callLogs.ts inserted the project but never
 * backfilled project_id on existing rows, and the route's GET handler did the
 * backfill but only after a manual list call — so a brand-new session's first
 * request could leave workspace_root populated with project_id NULL.
 *
 * The linker is best-effort: it never throws, and a failure (schema drift,
 * missing call_logs columns, unwritable directory) leaves the row with
 * workspace_root set and project_id NULL rather than blocking the request.
 */

import { getDbInstance } from "../db/core";
import { getProjectByBasePath, insertProject, type ProjectRegistry } from "../db/projectRegistry";
import { extractWorkspaceFromContext, scanProjectDirectory } from "../projectScanner";
import { randomUUID } from "node:crypto";

export interface WorkspaceLinkerContext {
  headers?: Headers | Record<string, string | null | undefined> | null;
  body?: unknown;
  sessionTag?: string | null;
}

export interface WorkspaceLinkerResult {
  workspaceRoot: string | null;
  projectId: string | null;
  /** True when a new project was auto-registered during this call. */
  registeredProject: boolean;
  /** Number of existing call_logs rows backfilled to the resolved project_id. */
  backfilled: number;
}

function hasColumn(db: ReturnType<typeof getDbInstance>, table: string, column: string): boolean {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((r: { name?: string }) => r.name === column);
  } catch {
    return false;
  }
}

function resolveProjectForRoot(rootPath: string): ProjectRegistry | null {
  let project = getProjectByBasePath(rootPath);
  if (project) return project;
  try {
    const scan = scanProjectDirectory(rootPath, "derived");
    const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return insertProject(
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
  } catch {
    return null;
  }
}

/**
 * Resolves the originating workspace/project for a request payload.
 *
 * Resolution order:
 *   1. Explicit workspace markers in request headers/body.
 *   2. Session-affinity fallback: inherit workspace_root from the most recent
 *      call_logs row sharing the same session_tag.
 *
 * Whenever a project is resolved (newly registered or looked up), any existing
 * call_logs rows with the same workspace_root but a NULL/empty project_id are
 * backfilled so the analytics queries join cleanly.
 */
export function resolveWorkspaceLinker(ctx: WorkspaceLinkerContext): WorkspaceLinkerResult {
  const db = getDbInstance();
  const result: WorkspaceLinkerResult = {
    workspaceRoot: null,
    projectId: null,
    registeredProject: false,
    backfilled: 0,
  };

  let candidateRoot: string | null = null;
  try {
    candidateRoot = extractWorkspaceFromContext(ctx.headers ?? null, ctx.body ?? null);
  } catch {
    candidateRoot = null;
  }

  if (!candidateRoot && ctx.sessionTag) {
    // Session affinity fallback.
    try {
      const latestRow = db
        .prepare(
          "SELECT workspace_root FROM call_logs WHERE session_tag = ? ORDER BY timestamp DESC LIMIT 1"
        )
        .get(ctx.sessionTag) as { workspace_root?: string } | undefined;
      if (latestRow?.workspace_root) {
        candidateRoot = latestRow.workspace_root;
      }
    } catch {
      // Best-effort
    }
  }

  if (!candidateRoot) return result;

  const project = resolveProjectForRoot(candidateRoot);
  if (!project) return result;

  result.workspaceRoot = candidateRoot;
  result.projectId = project.id;
  result.registeredProject =
    project.createdAt === project.updatedAt ||
    Math.abs((project.updatedAt ?? 0) - (project.createdAt ?? 0)) < 1;

  // Backfill dangling rows so analytics joins never see NULL project_id.
  if (hasColumn(db, "call_logs", "project_id")) {
    try {
      const r = db
        .prepare(
          `UPDATE call_logs
           SET project_id = ?
           WHERE workspace_root = ? AND (project_id IS NULL OR project_id = '')`
        )
        .run(project.id, candidateRoot);
      result.backfilled = r?.changes ?? 0;
    } catch {
      // Best-effort
    }
  }

  return result;
}
