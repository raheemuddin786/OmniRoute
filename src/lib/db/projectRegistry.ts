/**
 * db/projectRegistry.ts — Project registry and on-demand analytics cache.
 *
 * Stores project metadata and caches computed analytics for lazy loading.
 * All queries are read-only except the insert/update functions used for project
 * registration and management. Tier 2 analytics are computed on-demand.
 */

import { getDbInstance } from "./core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectRegistry {
  id: string;
  name: string;
  basePath: string;
  description?: string;
  techStack?: string[];
  cloudStack?: string[];
  features?: string[];
  filesCount?: number;
  docsCount?: number;
  status?: "active" | "inactive" | "archiving";
  provenance?: "derived" | "manual";
  memoryLocations?: string[];
  ragStatus?: "idle" | "indexing" | "healthy";
  ragIndexedCount?: number;
  analyticsCache?: ProjectAnalytics | null;
  analyticsCachedAt?: number;
  briefCache?: ProjectBrief | null;
  briefGeneratedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectAnalytics {
  tokenEconomics: TokenEconomics;
  sessions: SessionSummary;
  agents: AgentUsageSummary;
  optimizations?: string[];
  lastComputedAt: number;
}

export interface TokenEconomics {
  success: number;
  wasted: number;
  cached: number;
  saved: number;
  costUsd: number;
}

export interface RecentPromptRecord {
  prompt: string;
  timestamp: string;
  systemPrompt?: string;
  model?: string;
  requestedModel?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  tokensReasoning?: number;
  costUsd?: number;
  durationMs?: number;
  status?: number;
  toolsUsed?: string[];
  filesModified?: string[];
  sessionTag?: string;
  responseSummary?: string;
  provider?: string;
  comboName?: string;
  errorType?: string | null;
  errorSummary?: string | null;
  resilienceActions?: string | null;
}

export interface SessionSummary {
  total: number;
  uniquePrompts: number;
  recentPrompts?: RecentPromptRecord[];
}

export interface AgentUsageSummary {
  skills: SkillUsageSummary;
  mcpTools?: number;
  models?: ModelUsageSummary;
  combos?: string[];
}

export interface SkillUsageSummary {
  total: number;
  byCategory?: Record<string, number>;
}

export interface ModelUsageSummary {
  total: number;
  byModel?: Record<string, number>;
}

export interface ProjectBrief {
  summary: string;
  optimizations: string[];
  recommendations: string[];
  generatedAt: number;
}

interface RawProjectRow {
  id: string;
  name: string;
  base_path: string;
  description: string | null;
  tech_stack: string | null;
  cloud_stack: string | null;
  features: string | null;
  files_count: number | null;
  docs_count: number | null;
  status: string | null;
  provenance: string | null;
  memory_locations: string | null;
  rag_status: string | null;
  rag_indexed_count: number | null;
  analytics_cache: string | null;
  analytics_cached_at: number | null;
  brief_cache: string | null;
  brief_generated_at: number | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function jsonOrEmpty(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJson<T>(value?: string | null, fallback: T | null = null): T | null {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRowToProject(row: RawProjectRow): ProjectRegistry {
  return {
    id: row.id,
    name: row.name,
    basePath: row.base_path,
    description: row.description ?? undefined,
    techStack: jsonOrEmpty(row.tech_stack),
    cloudStack: jsonOrEmpty(row.cloud_stack),
    features: jsonOrEmpty(row.features),
    filesCount: row.files_count ?? 0,
    docsCount: row.docs_count ?? 0,
    status: (row.status as ProjectRegistry["status"]) ?? "active",
    provenance: (row.provenance as ProjectRegistry["provenance"]) ?? "derived",
    memoryLocations: jsonOrEmpty(row.memory_locations),
    ragStatus: (row.rag_status as ProjectRegistry["ragStatus"]) ?? "idle",
    ragIndexedCount: row.rag_indexed_count ?? 0,
    analyticsCache: safeJson<ProjectAnalytics>(row.analytics_cache),
    analyticsCachedAt: row.analytics_cached_at ?? 0,
    briefCache: safeJson<ProjectBrief>(row.brief_cache),
    briefGeneratedAt: row.brief_generated_at ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Core exports
// ---------------------------------------------------------------------------

export function insertProject(
  id: string,
  name: string,
  basePath: string,
  description?: string,
  techStack?: string[],
  cloudStack?: string[],
  features?: string[],
  filesCount?: number,
  docsCount?: number,
  status: "active" | "inactive" | "archiving" = "active",
  provenance: "derived" | "manual" = "derived",
  memoryLocations?: string[]
): ProjectRegistry {
  const db = getDbInstance();
  const nowMs = nowSeconds();
  db.prepare(
    `INSERT OR REPLACE INTO project_registry (
      id, name, base_path, description, tech_stack, cloud_stack, features,
      files_count, docs_count, status, provenance, memory_locations,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    basePath,
    description ?? null,
    JSON.stringify(techStack ?? []),
    JSON.stringify(cloudStack ?? []),
    JSON.stringify(features ?? []),
    filesCount ?? 0,
    docsCount ?? 0,
    status,
    provenance,
    JSON.stringify(memoryLocations ?? []),
    nowMs,
    nowMs
  );

  return getProject(id)!;
}

export function updateProjectMeta(id: string, patch: Partial<ProjectRegistry>): boolean {
  const db = getDbInstance();
  const nowMs = nowSeconds();
  const fields: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    fields.push("name = ?");
    params.push(patch.name);
  }
  if (patch.basePath !== undefined) {
    fields.push("base_path = ?");
    params.push(patch.basePath);
  }
  if (patch.description !== undefined) {
    fields.push("description = ?");
    params.push(patch.description ?? null);
  }
  if (patch.techStack !== undefined) {
    fields.push("tech_stack = ?");
    params.push(JSON.stringify(patch.techStack));
  }
  if (patch.cloudStack !== undefined) {
    fields.push("cloud_stack = ?");
    params.push(JSON.stringify(patch.cloudStack));
  }
  if (patch.features !== undefined) {
    fields.push("features = ?");
    params.push(JSON.stringify(patch.features));
  }
  if (patch.filesCount !== undefined) {
    fields.push("files_count = ?");
    params.push(patch.filesCount);
  }
  if (patch.docsCount !== undefined) {
    fields.push("docs_count = ?");
    params.push(patch.docsCount);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    params.push(patch.status);
  }
  if (patch.provenance !== undefined) {
    fields.push("provenance = ?");
    params.push(patch.provenance);
  }
  if (patch.memoryLocations !== undefined) {
    fields.push("memory_locations = ?");
    params.push(JSON.stringify(patch.memoryLocations));
  }
  if (patch.ragStatus !== undefined) {
    fields.push("rag_status = ?");
    params.push(patch.ragStatus);
  }
  if (patch.ragIndexedCount !== undefined) {
    fields.push("rag_indexed_count = ?");
    params.push(patch.ragIndexedCount);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = ?");
  params.push(nowMs);

  const sql = `UPDATE project_registry SET ${fields.join(", ")} WHERE id = ?`;
  params.push(id);

  const result = db.prepare(sql).run(...params);
  return (result?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Schema-drift resilience
// ---------------------------------------------------------------------------
//
// The production database was created from a pre-217 schema snapshot that
// lacked the `provenance` and `status` columns declared in migration 217's
// CREATE TABLE. SQLite's ALTER TABLE ADD COLUMN is the only safe way to add
// columns to an existing table, so until migration 220 runs, any SELECT that
// references those columns throws "no such column". The auto-registration path
// in saveCallLog wraps its work in a best-effort try/catch, so that throw
// silently swallowed the entire insert — the workspace was discovered but
// never registered, leaving call_logs.workspace_root populated with
// project_id NULL.
//
// To make the system robust regardless of migration state, every read helper
// here resolves the column set dynamically and never assumes a column exists.
// Writes always use the full column list (INSERT OR REPLACE / UPDATE), which
// is safe because the migration adds the columns before any write runs.

function projectRegistryColumns(db: ReturnType<typeof getDbInstance>): Set<string> {
  try {
    return new Set(
      (db.prepare("PRAGMA table_info(project_registry)").all() as Array<{ name?: string }>).map(
        (r) => r.name ?? ""
      )
    );
  } catch {
    return new Set<string>();
  }
}

function selectProjectSql(db: ReturnType<typeof getDbInstance>): string {
  const cols = projectRegistryColumns(db);
  const wanted = [
    "id",
    "name",
    "base_path",
    "description",
    "tech_stack",
    "cloud_stack",
    "features",
    "files_count",
    "docs_count",
    "status",
    "provenance",
    "memory_locations",
    "rag_status",
    "rag_indexed_count",
    "analytics_cache",
    "analytics_cached_at",
    "brief_cache",
    "brief_generated_at",
    "created_at",
    "updated_at",
  ];
  const available = wanted.filter((c) => cols.has(c));
  return `SELECT ${available.join(", ")} FROM project_registry`;
}

export function getProject(id: string): ProjectRegistry | null {
  const db = getDbInstance();
  const row = db.prepare(`${selectProjectSql(db)} WHERE id = ?`).get(id) as
    RawProjectRow | undefined;
  return row ? mapRowToProject(row) : null;
}

export function getProjectByBasePath(basePath: string): ProjectRegistry | null {
  const db = getDbInstance();
  const row = db.prepare(`${selectProjectSql(db)} WHERE base_path = ?`).get(basePath) as
    RawProjectRow | undefined;
  return row ? mapRowToProject(row) : null;
}

export function listProjects(status?: ProjectRegistry["status"]): ProjectRegistry[] {
  const db = getDbInstance();
  const baseSql = selectProjectSql(db);
  const sql = status
    ? `${baseSql} WHERE status = ? ORDER BY name ASC`
    : `${baseSql} ORDER BY name ASC`;
  const rows = (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as RawProjectRow[];
  return rows.map(mapRowToProject);
}

export function deleteProject(id: string): boolean {
  const db = getDbInstance();
  const result = db.prepare(`DELETE FROM project_registry WHERE id = ?`).run(id);
  return (result?.changes ?? 0) > 0;
}

/**
 * Archive a project. Archiving keeps the row (and its analytics cache) intact
 * so historical call_logs rows referencing it remain queryable, but hides it
 * from the default active list. Unlike DELETE, archive is reversible via
 * reactivateProject().
 */
export function archiveProject(id: string): ProjectRegistry | null {
  return updateProjectStatus(id, "archiving");
}

/**
 * Reactivate an archived project back to the active state.
 */
export function reactivateProject(id: string): ProjectRegistry | null {
  return updateProjectStatus(id, "active");
}

function updateProjectStatus(
  id: string,
  status: ProjectRegistry["status"]
): ProjectRegistry | null {
  const db = getDbInstance();
  const cols = projectRegistryColumns(db);
  if (!cols.has("status")) {
    // Pre-migration schema: nothing to update, return the row as-is.
    return getProject(id);
  }
  db.prepare(`UPDATE project_registry SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    nowSeconds(),
    id
  );
  return getProject(id);
}

export function setAnalyticsCache(id: string, analytics: ProjectAnalytics): void {
  const db = getDbInstance();
  db.prepare(
    `UPDATE project_registry SET analytics_cache = ?, analytics_cached_at = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(analytics), nowSeconds(), nowSeconds(), id);
}

export function setBriefCache(id: string, brief: ProjectBrief): void {
  const db = getDbInstance();
  db.prepare(
    `UPDATE project_registry SET brief_cache = ?, brief_generated_at = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(brief), nowSeconds(), nowSeconds(), id);
}
