import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated DATA_DIR before importing DB modules
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-project-memory-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createMemory } = await import("../../src/lib/memory/store.ts");
const { retrieveMemories, filterMemoriesByProject } =
  await import("../../src/lib/memory/retrieval.ts");
const { MemoryType } = await import("../../src/lib/memory/types.ts");
const { toMemoryRetrievalConfig } = await import("../../src/lib/memory/settings.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("filterMemoriesByProject isolates memories matching projectId or workspaceRoot", () => {
  const memories = [
    {
      id: "mem-1",
      apiKeyId: "key-1",
      sessionId: "s1",
      type: MemoryType.FACTUAL,
      key: "pref_1",
      content: "Uses hospital brochure palette",
      metadata: { projectId: "proj_hospital", workspaceRoot: "/work/hospital-brochure" },
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      accessCount: 0,
      lastAccessedAt: null,
    },
    {
      id: "mem-2",
      apiKeyId: "key-1",
      sessionId: "s2",
      type: MemoryType.FACTUAL,
      key: "pref_2",
      content: "OmniRoute uses TypeScript strictly",
      metadata: { projectId: "proj_omniroute", workspaceRoot: "/work/omniroute" },
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      accessCount: 0,
      lastAccessedAt: null,
    },
    {
      id: "mem-3",
      apiKeyId: "key-1",
      sessionId: "s3",
      type: MemoryType.FACTUAL,
      key: "pref_3",
      content: "Global preference for dark mode",
      metadata: { category: "preference" },
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
      accessCount: 0,
      lastAccessedAt: null,
    },
  ];

  // Request from omniroute project
  const omniMemories = filterMemoriesByProject(memories, "proj_omniroute", "/work/omniroute");
  const omniIds = omniMemories.map((m) => m.id);
  assert.ok(omniIds.includes("mem-2"), "Must include project-specific memory");
  assert.ok(omniIds.includes("mem-3"), "Must include unscoped global memory");
  assert.ok(
    !omniIds.includes("mem-1"),
    "Must NOT include unrelated project memory (hospital brochure)"
  );

  // Request from hospital project
  const hospitalMemories = filterMemoriesByProject(
    memories,
    "proj_hospital",
    "/work/hospital-brochure"
  );
  const hospitalIds = hospitalMemories.map((m) => m.id);
  assert.ok(hospitalIds.includes("mem-1"), "Must include hospital memory");
  assert.ok(hospitalIds.includes("mem-3"), "Must include unscoped global memory");
  assert.ok(!hospitalIds.includes("mem-2"), "Must NOT include omniroute memory");
});

test("retrieveMemories strictly filters by project when projectId / workspaceRoot are supplied", async () => {
  const apiKeyId = "test-api-key-project-isolation";

  await createMemory({
    apiKeyId,
    sessionId: "sess-hospital",
    type: MemoryType.FACTUAL,
    key: "hospital_doc",
    content: "Doctor brochure needs cardiology section",
    metadata: {
      projectId: "proj_hospital",
      workspaceRoot: "/path/to/hospital-brochure-mono",
    },
    expiresAt: null,
  });

  await createMemory({
    apiKeyId,
    sessionId: "sess-omniroute",
    type: MemoryType.FACTUAL,
    key: "omniroute_rules",
    content: "Always run npm run typecheck:core",
    metadata: {
      projectId: "proj_omniroute",
      workspaceRoot: "/path/to/rashiza-omni",
    },
    expiresAt: null,
  });

  await createMemory({
    apiKeyId,
    sessionId: "sess-global",
    type: MemoryType.FACTUAL,
    key: "user_name",
    content: "User name is Raheem",
    metadata: {
      category: "preference",
    },
    expiresAt: null,
  });

  // Query in omniroute workspace
  const omniResults = await retrieveMemories(apiKeyId, {
    enabled: true,
    maxTokens: 2000,
    retrievalStrategy: "exact",
    scope: "apiKey",
    projectId: "proj_omniroute",
    workspaceRoot: "/path/to/rashiza-omni",
  });

  const omniKeys = omniResults.map((r) => r.key);
  assert.ok(omniKeys.includes("omniroute_rules"), "OmniRoute project memory should be retrieved");
  assert.ok(omniKeys.includes("user_name"), "Global unscoped memory should be preserved");
  assert.ok(
    !omniKeys.includes("hospital_doc"),
    "Hospital brochure memory MUST be isolated and omitted"
  );

  // Query in hospital workspace
  const hospitalResults = await retrieveMemories(apiKeyId, {
    enabled: true,
    maxTokens: 2000,
    retrievalStrategy: "exact",
    scope: "apiKey",
    projectId: "proj_hospital",
    workspaceRoot: "/path/to/hospital-brochure-mono",
  });

  const hospitalKeys = hospitalResults.map((r) => r.key);
  assert.ok(hospitalKeys.includes("hospital_doc"), "Hospital project memory should be retrieved");
  assert.ok(hospitalKeys.includes("user_name"), "Global unscoped memory should be preserved");
  assert.ok(
    !hospitalKeys.includes("omniroute_rules"),
    "OmniRoute memory MUST be omitted in hospital workspace"
  );
});

test("toMemoryRetrievalConfig passes projectId and workspaceRoot through", () => {
  const dummySettings = {
    enabled: true,
    maxTokens: 1000,
    retentionDays: 30,
    strategy: "hybrid" as const,
    skillsEnabled: true,
    embeddingSource: "auto" as const,
    embeddingProviderModel: null,
    customBaseUrl: null,
    customModelId: null,
    transformersEnabled: false,
    staticEnabled: false,
    rerankEnabled: false,
    rerankProviderModel: null,
    vectorStore: "auto" as const,
    primaryBackend: "sqlite",
    fallbackBackends: [],
    backendConfigs: {},
  };

  const config = toMemoryRetrievalConfig(dummySettings, {
    query: "test query",
    projectId: "proj_123",
    workspaceRoot: "/my/project",
  });

  assert.equal(config.projectId, "proj_123");
  assert.equal(config.workspaceRoot, "/my/project");
  assert.equal(config.query, "test query");
});
