import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DB-backed project registry test using isolated DATA_DIR
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proj-reg-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const reg = await import("../../src/lib/db/projectRegistry.ts");
const scanner = await import("../../src/lib/projectScanner.ts");
const analytics = await import("../../open-sse/services/projectAnalytics.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("insertProject creates and returns a valid project record", () => {
  const p = reg.insertProject(
    "proj_test_001",
    "Test Project Alpha",
    "/tmp/test-alpha",
    "Alpha test description",
    ["TypeScript", "React"],
    ["Docker"],
    ["Streaming"],
    42,
    5,
    "active",
    "derived",
    ["/tmp/test-alpha/docs"]
  );

  assert.equal(p.id, "proj_test_001");
  assert.equal(p.name, "Test Project Alpha");
  assert.equal(p.basePath, "/tmp/test-alpha");
  assert.deepEqual(p.techStack, ["TypeScript", "React"]);
  assert.deepEqual(p.cloudStack, ["Docker"]);
  assert.deepEqual(p.features, ["Streaming"]);
  assert.equal(p.filesCount, 42);
  assert.equal(p.docsCount, 5);
  assert.equal(p.status, "active");
  assert.equal(p.provenance, "derived");
});

test("getProject and listProjects retrieve stored records", () => {
  const found = reg.getProject("proj_test_001");
  assert.ok(found);
  assert.equal(found.name, "Test Project Alpha");

  const list = reg.listProjects();
  assert.ok(list.length >= 1);
  const matched = list.find((item) => item.id === "proj_test_001");
  assert.ok(matched);
  assert.equal(matched.name, "Test Project Alpha");
});

test("updateProjectMeta patches project metadata safely", () => {
  const updated = reg.updateProjectMeta("proj_test_001", {
    name: "Updated Alpha",
    filesCount: 99,
    docsCount: 12,
  });
  assert.equal(updated, true);

  const found = reg.getProject("proj_test_001");
  assert.ok(found);
  assert.equal(found.name, "Updated Alpha");
  assert.equal(found.filesCount, 99);
  assert.equal(found.docsCount, 12);
});

test("setAnalyticsCache and setBriefCache store and retrieve on-demand data", () => {
  reg.setAnalyticsCache("proj_test_001", {
    tokenEconomics: {
      success: 1000,
      wasted: 50,
      cached: 200,
      saved: 170,
      costUsd: 0.005,
    },
    sessions: {
      total: 10,
      uniquePrompts: 8,
    },
    agents: {
      skills: { total: 4 },
      models: { total: 10, byModel: { "claude-sonnet-5-5": 10 } },
    },
    lastComputedAt: 1700000000,
  });

  const withAnalytics = reg.getProject("proj_test_001");
  assert.ok(withAnalytics?.analyticsCache);
  assert.equal(withAnalytics.analyticsCache.tokenEconomics.success, 1000);
  assert.equal(withAnalytics.analyticsCache.sessions.total, 10);

  reg.setBriefCache("proj_test_001", {
    summary: "Alpha summary brief",
    optimizations: ["Enable caching"],
    recommendations: ["Review fallbacks"],
    generatedAt: 1700000000,
  });

  const withBrief = reg.getProject("proj_test_001");
  assert.ok(withBrief?.briefCache);
  assert.equal(withBrief.briefCache.summary, "Alpha summary brief");
  assert.deepEqual(withBrief.briefCache.optimizations, ["Enable caching"]);
});

test("scanProjectDirectory inspects directory structure safely", () => {
  const scanned = scanner.scanProjectDirectory(process.cwd());
  assert.ok(scanned.name);
  assert.ok(scanned.filesCount > 0);
  assert.ok(scanned.techStack.length > 0);
  assert.ok(scanned.techStack.includes("Node.js") || scanned.techStack.includes("TypeScript"));
});

test("autoDiscoverWorkspaces derives candidate workspaces from filesystem and logs", () => {
  const workspaces = scanner.autoDiscoverWorkspaces([`Executed query in ${process.cwd()}/src/app`]);
  assert.ok(Array.isArray(workspaces));
  assert.ok(workspaces.length >= 1);
  const foundSelf = workspaces.find((w) => w.basePath === process.cwd());
  assert.ok(foundSelf);
  assert.equal(foundSelf.provenance, "derived");
});

test("calculateProjectAnalytics computes metrics on-demand for project and global", async () => {
  // Project-scoped analytics
  const result = await analytics.calculateProjectAnalytics("proj_test_001");
  assert.ok(result);
  assert.ok(typeof result.tokenEconomics.success === "number");
  assert.ok(typeof result.tokenEconomics.wasted === "number");
  assert.ok(typeof result.tokenEconomics.costUsd === "number");
  assert.ok(typeof result.sessions.total === "number");
  assert.ok(Array.isArray(result.optimizations));

  // Global-scoped analytics
  const globalResult = await analytics.calculateProjectAnalytics(null);
  assert.ok(globalResult);
  assert.ok(typeof globalResult.tokenEconomics.success === "number");
  assert.ok(typeof globalResult.sessions.total === "number");
});

test("generateProjectBrief generates executive brief on-demand for project and global", async () => {
  // Project-scoped brief
  const brief = await analytics.generateProjectBrief("proj_test_001");
  assert.ok(brief);
  assert.ok(brief.summary.includes("Updated Alpha"));
  assert.ok(Array.isArray(brief.optimizations));
  assert.ok(Array.isArray(brief.recommendations));

  // Global-scoped brief
  const globalBrief = await analytics.generateProjectBrief("__global__");
  assert.ok(globalBrief);
  assert.ok(globalBrief.summary.includes("Global Application Overview"));
});

test("deleteProject removes the project record", () => {
  const deleted = reg.deleteProject("proj_test_001");
  assert.equal(deleted, true);

  const found = reg.getProject("proj_test_001");
  assert.equal(found, null);
});
