import test from "node:test";
import assert from "node:assert/strict";
import {
  expandLedgerWithApex,
  classifyFollowUp,
  judgeCompletion,
  heuristicFallback,
  gatherApexContext,
  isSensitiveFile,
  trimPatch,
  trimTree,
  cleanAndParseJson,
  ApexLedgerExpansionSchema,
  type ModelDispatchFn,
} from "../../open-sse/services/spb/apexLedger.ts";
import type {
  GuidanceContract,
  IntentLedgerItem,
} from "../../open-sse/services/spb/intentAnalyzer.ts";

test("SPB Apex Ledger: gatherApexContext and cleanAndParseJson handle inputs correctly", () => {
  const ctx = gatherApexContext({
    prompt: "Fix src/components/Form.tsx",
    conversationMessages: [{ role: "user", content: "hello" }],
  });
  assert.equal(ctx.contextSource, "conversation");
  assert.ok(ctx.conversationExcerpts?.length);

  const parsed = cleanAndParseJson(
    '```json\n{"isActionable": true, "intents": [], "nonGoals": []}\n```',
    ApexLedgerExpansionSchema
  );
  assert.ok(parsed);
  assert.equal(parsed.isActionable, true);

  const fallbackItems = heuristicFallback("1. Fix UI\n2. Add test", 4);
  assert.ok(fallbackItems.length >= 2);
});

test("SPB Apex Ledger: isSensitiveFile flags .env, credentials, and tokens", () => {
  assert.equal(isSensitiveFile(".env"), true);
  assert.equal(isSensitiveFile(".env.local"), true);
  assert.equal(isSensitiveFile("config/jwt_secret.key"), true);
  assert.equal(isSensitiveFile("server.pem"), true);
  assert.equal(isSensitiveFile("id_rsa"), true);
  assert.equal(isSensitiveFile("node_modules/pkg/index.js"), true);
  assert.equal(isSensitiveFile(".git/HEAD"), true);
  assert.equal(isSensitiveFile("src/components/Form.tsx"), false);
  assert.equal(isSensitiveFile("src/app/api/route.ts"), false);
});

test("SPB Apex Ledger: trimPatch and trimTree enforce budget limits", () => {
  const hugePatch = "diff --git a/file b/file\n" + "+ line\n".repeat(5000);
  const trimmedP = trimPatch(hugePatch, 500);
  assert.ok(trimmedP.length <= 600);
  assert.ok(trimmedP.includes("[...diff truncated for model budget...]"));

  const hugeTree = "src/\n  components/\n".repeat(1000);
  const trimmedT = trimTree(hugeTree, 300);
  assert.ok(trimmedT.length <= 400);
  assert.ok(trimmedT.includes("[...directory tree truncated...]"));
});

test("SPB Apex Ledger: expandLedgerWithApex parses structured JSON and identifies implied dependencies", async () => {
  let dispatchCalled = 0;
  const mockDispatch: ModelDispatchFn = async () => {
    dispatchCalled++;
    return JSON.stringify({
      isActionable: true,
      intents: [
        {
          id: "I1",
          text: "Implement user authentication endpoint",
          kind: "explicit",
          layer: "api",
          targetFiles: ["src/api/auth.ts"],
          acceptance: "POST /auth returns JWT token",
        },
        {
          id: "I2",
          text: "Add database migration for users table",
          kind: "required-implied",
          parentId: "I1",
          reason: "User credentials must be stored in persistent database",
          layer: "data",
          targetFiles: ["src/lib/db/migrations/001_users.sql"],
          acceptance: "Table users exists with id, email, password_hash",
        },
      ],
      nonGoals: ["Do not add OAuth providers"],
    });
  };

  const context = {
    contextSource: "repo" as const,
    treeExcerpt: "src/\n  api/\n",
  };

  const prompt = "Build user authentication endpoint with database persistence";
  const res = await expandLedgerWithApex(prompt, context, mockDispatch, {
    promptAnchorHash: "test_anchor_auth_" + Date.now(),
  });

  assert.equal(dispatchCalled, 1);
  assert.equal(res.isActionable, true);
  assert.equal(res.intents.length, 2);
  assert.equal(res.intents[0].id, "I1");
  assert.equal(res.intents[0].kind, "explicit");
  assert.equal(res.intents[1].id, "I2");
  assert.equal(res.intents[1].kind, "required-implied");
  assert.equal(res.intents[1].parentId, "I1");
  assert.ok(res.intents[1].reason);
  assert.deepEqual(res.nonGoals, ["Do not add OAuth providers"]);
});

test("SPB Apex Ledger: advisory questions return isActionable=false with empty intents", async () => {
  const mockDispatch: ModelDispatchFn = async () => {
    return JSON.stringify({
      isActionable: false,
      intents: [],
      nonGoals: [],
    });
  };

  const res = await expandLedgerWithApex(
    "How do I add authentication in this repo?",
    { contextSource: "conversation" },
    mockDispatch
  );

  assert.equal(res.isActionable, false);
  assert.equal(res.intents.length, 0);
});

test("SPB Apex Ledger: expandLedgerWithApex returns cached expansion on repeat call without extra LLM invocation", async () => {
  let calls = 0;
  const mockDispatch: ModelDispatchFn = async () => {
    calls++;
    return JSON.stringify({
      isActionable: true,
      intents: [
        {
          id: "I1",
          text: "Refactor router",
          kind: "explicit",
          layer: "api",
          targetFiles: ["src/router.ts"],
          acceptance: "Router compiles",
        },
      ],
      nonGoals: [],
    });
  };

  const fixedAnchor = "cache_anchor_test_fixed";
  const context = { contextSource: "repo" as const, treeExcerpt: "src/router.ts" };

  const first = await expandLedgerWithApex("Refactor router", context, mockDispatch, {
    promptAnchorHash: fixedAnchor,
  });
  assert.equal(calls, 1);
  assert.equal(first.intents.length, 1);

  // Repeat call with same anchor and context
  const second = await expandLedgerWithApex("Refactor router", context, mockDispatch, {
    promptAnchorHash: fixedAnchor,
  });
  assert.equal(calls, 1, "Should hit SQLite cache and not call dispatchFn a second time");
  assert.equal(second.intents.length, 1);
});

test("SPB Apex Ledger: expandLedgerWithApex falls back cleanly to heuristic decomposition on model error", async () => {
  const failingDispatch: ModelDispatchFn = async () => {
    throw new Error("Apex model 503 Overloaded");
  };

  const res = await expandLedgerWithApex(
    "1. Fix API login\n2. Add DB migration",
    { contextSource: "repo" },
    failingDispatch
  );

  assert.ok(res.intents.length >= 2, "Heuristic fallback should extract at least 2 items");
  assert.equal(res.isActionable, true);
});

test("SPB Apex Ledger: classifyFollowUp classifies continuation and unblocks blocked items", async () => {
  const contract: GuidanceContract = {
    intents: [
      {
        id: "I1",
        text: "Add login route",
        kind: "explicit",
        layer: "api",
        acceptance: "Returns 200",
        status: "blocked",
      },
    ],
  };

  const mockDispatch: ModelDispatchFn = async () => {
    return JSON.stringify({
      relation: "continuation",
      directive: "[SPB Continuation: Unblocked]",
    });
  };

  const res = await classifyFollowUp(contract, "Please continue and complete it", mockDispatch);
  assert.equal(res.relation, "continuation");
  assert.equal(res.ledger[0].status, "in_progress");
  assert.ok(res.directive?.includes("Unblocked"));
});

test("SPB Apex Ledger: classifyFollowUp classifies amendment and updates ledger items", async () => {
  const contract: GuidanceContract = {
    intents: [
      {
        id: "I1",
        text: "Add login route",
        kind: "explicit",
        layer: "api",
        acceptance: "Returns 200",
        status: "open",
      },
      {
        id: "I2",
        text: "Add avatar upload",
        kind: "optional",
        layer: "ui",
        acceptance: "Avatar uploaded",
        status: "open",
      },
    ],
  };

  const mockDispatch: ModelDispatchFn = async () => {
    return JSON.stringify({
      relation: "amendment",
      directive: "[SPB Amendment: Skipping avatar upload]",
      intents: [
        {
          id: "I1",
          text: "Add login route",
          kind: "explicit",
          layer: "api",
          targetFiles: [],
          acceptance: "Returns 200",
          status: "open",
        },
        {
          id: "I2",
          text: "Add avatar upload",
          kind: "optional",
          layer: "ui",
          targetFiles: [],
          acceptance: "Avatar uploaded",
          status: "skipped",
        },
        {
          id: "I3",
          text: "Add password reset endpoint",
          kind: "explicit",
          layer: "api",
          targetFiles: [],
          acceptance: "POST /reset returns 200",
          status: "open",
        },
      ],
    });
  };

  const res = await classifyFollowUp(
    contract,
    "Actually skip avatar upload and also add password reset",
    mockDispatch
  );
  assert.equal(res.relation, "amendment");
  assert.equal(res.ledger.length, 3);
  assert.equal(res.ledger.find((i) => i.id === "I2")?.status, "skipped");
  assert.equal(res.ledger.find((i) => i.id === "I3")?.status, "open");
});

test("SPB Apex Ledger: judgeCompletion marks item done when mechanical evidence supports it", async () => {
  const ledger: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Fix auth route",
      kind: "explicit",
      layer: "api",
      acceptance: "Returns 200",
      status: "open",
    },
  ];

  const evidence = {
    diffDelta: {
      files: ["src/api/auth.ts"],
      hashes: { "src/api/auth.ts": "abc123hash" },
    },
    testCommands: [{ command: "npm test", exitCode: 0 }],
    observedReadFiles: ["src/api/auth.ts"],
    observedWrittenFiles: ["src/api/auth.ts"],
    diffVisible: true,
  };

  const mockDispatch: ModelDispatchFn = async () => {
    return JSON.stringify({
      items: [
        {
          id: "I1",
          status: "done",
          evidence: "Modified src/api/auth.ts with passing npm test exit code 0",
          missing: "",
        },
      ],
      outOfScopeFiles: [],
      reprompt: "",
      isSatisfied: true,
    });
  };

  const res = await judgeCompletion(ledger, evidence, "I fixed the auth route.", mockDispatch);
  assert.equal(res.isSatisfied, true);
  assert.equal(res.items[0].status, "done");
  assert.deepEqual(res.outOfScopeFiles, []);
});

test("SPB Apex Ledger: judgeCompletion flags outOfScopeFiles and reprompts agent (Requirement A)", async () => {
  const ledger: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Fix auth route",
      kind: "explicit",
      layer: "api",
      acceptance: "Returns 200",
      status: "open",
    },
  ];

  const evidence = {
    diffDelta: {
      files: ["src/api/auth.ts", "unrelated/secret_module.ts"],
      hashes: { "src/api/auth.ts": "abc", "unrelated/secret_module.ts": "xyz" },
    },
    testCommands: [],
    observedReadFiles: ["src/api/auth.ts"],
    observedWrittenFiles: ["src/api/auth.ts", "unrelated/secret_module.ts"],
    diffVisible: true,
  };

  const mockDispatch: ModelDispatchFn = async () => {
    return JSON.stringify({
      items: [
        {
          id: "I1",
          status: "done",
          evidence: "Modified src/api/auth.ts",
          missing: "",
        },
      ],
      outOfScopeFiles: ["unrelated/secret_module.ts"],
      reprompt: "Please revert unrelated changes to unrelated/secret_module.ts.",
      isSatisfied: false,
    });
  };

  const res = await judgeCompletion(ledger, evidence, "Completed.", mockDispatch);
  assert.equal(res.isSatisfied, false);
  assert.deepEqual(res.outOfScopeFiles, ["unrelated/secret_module.ts"]);
  assert.ok(res.reprompt.includes("revert"));
});

test("SPB Apex Ledger: judgeCompletion marks done_unverified when diff is not visible (remote proxy)", async () => {
  const ledger: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Update UI",
      kind: "explicit",
      layer: "ui",
      acceptance: "Rendered",
      status: "in_progress",
    },
  ];

  const evidence = {
    diffDelta: { files: [], hashes: {} },
    testCommands: [],
    observedReadFiles: [],
    observedWrittenFiles: [],
    diffVisible: false, // Remote proxy
  };

  // Should NOT call dispatchFn because diffVisible: false handles it deterministically
  let modelCalled = false;
  const mockDispatch: ModelDispatchFn = async () => {
    modelCalled = true;
    return "{}";
  };

  const res = await judgeCompletion(ledger, evidence, "UI updated", mockDispatch);
  assert.equal(modelCalled, false);
  assert.equal(res.isSatisfied, true);
  assert.equal(res.items[0].status, "done_unverified");
});

test("SPB Apex Ledger: judgeCompletion fails open cleanly on judge error or timeout (Requirement C)", async () => {
  const ledger: IntentLedgerItem[] = [
    {
      id: "I1",
      text: "Update UI",
      kind: "explicit",
      layer: "ui",
      acceptance: "Rendered",
      status: "open",
    },
  ];

  const evidence = {
    diffDelta: { files: ["src/UI.tsx"], hashes: { "src/UI.tsx": "h1" } },
    testCommands: [],
    observedReadFiles: ["src/UI.tsx"],
    observedWrittenFiles: ["src/UI.tsx"],
    diffVisible: true,
  };

  const failingDispatch: ModelDispatchFn = async () => {
    throw new Error("Judge call timeout after 10000ms");
  };

  const res = await judgeCompletion(ledger, evidence, "I am finished", failingDispatch);
  assert.equal(res.isSatisfied, true, "Should fail open and never block user");
  assert.equal(res.items[0].status, "done_unverified");
  assert.ok(res.items[0].evidence.includes("Judge evaluation unavailable"));
});
