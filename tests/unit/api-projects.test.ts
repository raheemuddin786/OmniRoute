import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Setup isolated DATA_DIR for API test
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-projects-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { GET: getProjects, POST: createProject } =
  await import("../../src/app/api/v1/projects/route.ts");
const {
  GET: getProjectById,
  PATCH: patchProject,
  DELETE: deleteProject,
  POST: postProjectArchive,
} = await import("../../src/app/api/v1/projects/[id]/route.ts");
const { POST: postRefresh } = await import("../../src/app/api/v1/projects/refresh/route.ts");
const { POST: calculateAnalytics } =
  await import("../../src/app/api/v1/projects/[id]/analytics/route.ts");
const { POST: generateBrief } = await import("../../src/app/api/v1/projects/[id]/brief/route.ts");
const { POST: scanDirectory } = await import("../../src/app/api/v1/projects/scan/route.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

function mockRequest(method: string, url: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:20128",
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

test("API: GET /api/v1/projects auto-seeds current workspace and returns list", async () => {
  const req = mockRequest("GET", "http://localhost:20128/api/v1/projects");
  const res = await getProjects(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.projects));
  assert.ok(data.projects.length >= 1);
  const selfProject = data.projects.find((p: { basePath: string }) => p.basePath === process.cwd());
  assert.ok(selfProject);
  assert.equal(selfProject.basePath, process.cwd());
});

test("API: POST /api/v1/projects/scan previews filesystem metadata", async () => {
  const req = mockRequest("POST", "http://localhost:20128/api/v1/projects/scan", {
    basePath: process.cwd(),
  });
  const res = await scanDirectory(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.scan);
  assert.ok(data.scan.filesCount > 0);
  assert.ok(data.scan.techStack.length > 0);
});

test("API: POST /api/v1/projects registers a custom project", async () => {
  const req = mockRequest("POST", "http://localhost:20128/api/v1/projects", {
    basePath: "/tmp/custom-test-proj",
    name: "Custom Test Project",
    description: "Custom project description",
    techStack: ["Node.js", "Express"],
  });
  const res = await createProject(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.project.name, "Custom Test Project");
  assert.equal(data.project.basePath, "/tmp/custom-test-proj");

  const projectId = data.project.id;

  // GET /api/v1/projects/[id]
  const getReq = mockRequest("GET", `http://localhost:20128/api/v1/projects/${projectId}`);
  const getRes = await getProjectById(getReq, { params: Promise.resolve({ id: projectId }) });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.success, true);
  assert.equal(getData.project.id, projectId);

  // PATCH /api/v1/projects/[id]
  const patchReq = mockRequest("PATCH", `http://localhost:20128/api/v1/projects/${projectId}`, {
    description: "Updated description via PATCH",
    filesCount: 88,
  });
  const patchRes = await patchProject(patchReq, { params: Promise.resolve({ id: projectId }) });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.success, true);
  assert.equal(patchData.project.description, "Updated description via PATCH");
  assert.equal(patchData.project.filesCount, 88);

  // POST /api/v1/projects/[id]/analytics
  const anaReq = mockRequest(
    "POST",
    `http://localhost:20128/api/v1/projects/${projectId}/analytics`
  );
  const anaRes = await calculateAnalytics(anaReq, { params: Promise.resolve({ id: projectId }) });
  assert.equal(anaRes.status, 200);
  const anaData = await anaRes.json();
  assert.equal(anaData.success, true);
  assert.ok(anaData.analytics.tokenEconomics);

  // POST /api/v1/projects/__global__/analytics
  const globalAnaReq = mockRequest(
    "POST",
    `http://localhost:20128/api/v1/projects/__global__/analytics`
  );
  const globalAnaRes = await calculateAnalytics(globalAnaReq, {
    params: Promise.resolve({ id: "__global__" }),
  });
  assert.equal(globalAnaRes.status, 200);
  const globalAnaData = await globalAnaRes.json();
  assert.equal(globalAnaData.success, true);
  assert.ok(globalAnaData.analytics.tokenEconomics);

  // POST /api/v1/projects/[id]/brief
  const briefReq = mockRequest("POST", `http://localhost:20128/api/v1/projects/${projectId}/brief`);
  const briefRes = await generateBrief(briefReq, { params: Promise.resolve({ id: projectId }) });
  assert.equal(briefRes.status, 200);
  const briefData = await briefRes.json();
  assert.equal(briefData.success, true);
  assert.ok(briefData.brief.summary.includes("Custom Test Project"));

  // POST /api/v1/projects/__global__/brief
  const globalBriefReq = mockRequest(
    "POST",
    `http://localhost:20128/api/v1/projects/__global__/brief`
  );
  const globalBriefRes = await generateBrief(globalBriefReq, {
    params: Promise.resolve({ id: "__global__" }),
  });
  assert.equal(globalBriefRes.status, 200);
  const globalBriefData = await globalBriefRes.json();
  assert.equal(globalBriefData.success, true);
  assert.ok(globalBriefData.brief.summary.includes("Global Application Overview"));

  // DELETE /api/v1/projects/[id]
  const delReq = mockRequest("DELETE", `http://localhost:20128/api/v1/projects/${projectId}`);
  const delRes = await deleteProject(delReq, { params: Promise.resolve({ id: projectId }) });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.success, true);
});

test("API: GET /api/v1/projects auto-discovers distinct workspace_root from call_logs", async () => {
  const db = core.getDbInstance();

  // Create temporary valid workspace directory
  const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-discover-"));
  fs.writeFileSync(
    path.join(tempWorkspaceDir, "package.json"),
    JSON.stringify({ name: "auto-discovered-app", description: "Auto discovered workspace" })
  );

  // Insert a mock call log with this workspace_root
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, method, path, status, model, duration, workspace_root)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "call_auto_disc_001",
    new Date().toISOString(),
    "POST",
    "/v1/chat/completions",
    200,
    "gpt-4o",
    120,
    tempWorkspaceDir
  );

  const req = mockRequest("GET", "http://localhost:20128/api/v1/projects");
  const res = await getProjects(req);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  const discovered = data.projects.find(
    (p: { basePath: string }) => p.basePath === tempWorkspaceDir
  );
  assert.ok(discovered, "Workspace from call_logs should be auto-discovered and registered");
  assert.equal(discovered.basePath, tempWorkspaceDir);
  assert.equal(discovered.name, "auto-discovered-app");

  // Cleanup temp dir
  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {}
});

test("API: POST /api/v1/projects/[id] toggles archive status (archive & restore)", async () => {
  // Create a project first
  const req = mockRequest("POST", "http://localhost:20128/api/v1/projects", {
    basePath: "/tmp/archivable-proj",
    name: "Archivable Project",
    provenance: "manual",
  });
  const res = await createProject(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  const projectId = data.project.id;

  // Archive project
  const archiveReq = mockRequest("POST", `http://localhost:20128/api/v1/projects/${projectId}`, {
    action: "archive",
  });
  const archiveRes = await postProjectArchive(archiveReq, {
    params: Promise.resolve({ id: projectId }),
  });
  assert.equal(archiveRes.status, 200);
  const archiveData = await archiveRes.json();
  assert.equal(archiveData.success, true);
  assert.equal(archiveData.project.status, "archiving");

  // Reactivate project
  const restoreReq = mockRequest("POST", `http://localhost:20128/api/v1/projects/${projectId}`, {
    action: "reactivate",
  });
  const restoreRes = await postProjectArchive(restoreReq, {
    params: Promise.resolve({ id: projectId }),
  });
  assert.equal(restoreRes.status, 200);
  const restoreData = await restoreRes.json();
  assert.equal(restoreData.success, true);
  assert.equal(restoreData.project.status, "active");

  // Delete cleanup
  const delReq = mockRequest("DELETE", `http://localhost:20128/api/v1/projects/${projectId}`);
  await deleteProject(delReq, { params: Promise.resolve({ id: projectId }) });
});

test("API: POST /api/v1/projects/refresh triggers auto-discovery and backfills dangling rows", async () => {
  const db = core.getDbInstance();
  const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-refresh-"));
  fs.writeFileSync(
    path.join(tempWorkspaceDir, "package.json"),
    JSON.stringify({ name: "refreshed-app", description: "Discovered on refresh" })
  );

  // Insert a mock call log with this workspace_root and project_id = NULL
  const callId = `refresh-test-${Date.now()}`;
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, method, path, status, model, duration, workspace_root, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    callId,
    new Date().toISOString(),
    "POST",
    "/v1/messages",
    200,
    "test-model",
    100,
    tempWorkspaceDir
  );

  const req = mockRequest("POST", "http://localhost:20128/api/v1/projects/refresh");
  const res = await postRefresh(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.backfilled >= 1 || data.totalLinked >= 1);

  // Verify call_logs now has project_id populated
  const updatedRow = db.prepare("SELECT project_id FROM call_logs WHERE id = ?").get(callId) as
    { project_id?: string } | undefined;
  assert.ok(updatedRow?.project_id, "call_logs.project_id should be backfilled");

  try {
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  } catch {}
});
