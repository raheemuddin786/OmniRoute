import test from "node:test";
import assert from "node:assert/strict";
import {
  decomposeRequestIntoLedger,
  resolveSessionLifecycle,
  expandIntentLedgerApex,
} from "../../open-sse/services/spb/contextPartition.ts";
import {
  observeToolCallsOnLedger,
  evaluateLedgerCompletion,
  buildLedgerSummaryReport,
} from "../../open-sse/services/spb/outboundEvaluator.ts";
import {
  saveCheckpoint,
  getCheckpoint,
  updateGuidanceContract,
} from "../../src/lib/db/spbState.ts";
import type { GuidanceContract } from "../../open-sse/services/spb/intentAnalyzer.ts";

test("SPB Intent Ledger: decomposes composite 4-task prompt into structured items across layers", () => {
  const prompt =
    "1. Fix API route for user authentication\n" +
    "2. Add DB migration for profile table\n" +
    "3. Update UI form component with avatar upload\n" +
    "4. Write integration test suite verifying login flow";

  const ledger = decomposeRequestIntoLedger(prompt, 8);

  assert.equal(ledger.length >= 4, true, "Should extract at least 4 items");

  const apiItem = ledger.find((i) => i.layer === "api");
  assert.ok(apiItem, "Should identify API layer item");
  assert.equal(apiItem.kind, "explicit");
  assert.equal(apiItem.status, "open");

  const dataItem = ledger.find((i) => i.layer === "data");
  assert.ok(dataItem, "Should identify Data layer item");
  assert.equal(dataItem.kind, "explicit");

  const uiItem = ledger.find((i) => i.layer === "ui");
  assert.ok(uiItem, "Should identify UI layer item");
  assert.equal(uiItem.kind, "explicit");

  const testItem = ledger.find((i) => i.layer === "test");
  assert.ok(testItem, "Should identify Test layer item");
  assert.equal(testItem.kind, "explicit");
});

test("SPB Intent Ledger: infers required-implied items with parentId linkage", () => {
  const prompt = "Create a registration UI form with email, password, and avatar upload fields";

  const ledger = decomposeRequestIntoLedger(prompt, 8);

  const uiItem = ledger.find((i) => i.layer === "ui" && i.kind === "explicit");
  assert.ok(uiItem, "Should have explicit UI form item");

  const impliedApi = ledger.find(
    (i) => i.layer === "api" && i.kind === "required-implied" && i.parentId === uiItem.id
  );
  assert.ok(impliedApi, "Should infer required-implied API validation linked to parent UI item");

  const impliedTest = ledger.find(
    (i) => i.layer === "test" && i.kind === "optional" && i.parentId === uiItem.id
  );
  assert.ok(impliedTest, "Should infer optional test suite linked to parent UI item");
});

test("SPB Intent Ledger: observes mutating tool calls, updates status to in_progress, and catches out-of-scope edits", () => {
  const sessionId = "test_ledger_observe_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Implement auth API route and update profile UI",
    intents: [
      {
        id: "I1",
        text: "Fix API route for auth",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/auth/route.ts"],
        acceptance: "Returns 200 on valid credentials",
        status: "open",
      },
      {
        id: "I2",
        text: "Update Profile form UI",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/ProfileForm.tsx"],
        acceptance: "Renders avatar input",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_1",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Simulate assistant response with mutating tool call matching I1 and an out-of-scope tool call
  const extracted = {
    text: "",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Edit",
        args: JSON.stringify({ file_path: "src/app/api/auth/route.ts" }),
      },
      {
        name: "Write",
        args: JSON.stringify({ file_path: "unrelated/secret/config.json" }),
      },
    ],
  };

  const obs = observeToolCallsOnLedger(sessionId, extracted);

  assert.equal(obs.updatedCount, 1, "Should update 1 matching item (I1)");
  assert.equal(obs.violations.length, 1, "Should flag 1 out-of-scope file");
  assert.equal(obs.violations[0], "unrelated/secret/config.json");

  // Verify checkpoint was updated
  const updatedCheckpoint = getCheckpoint(sessionId);
  const updatedContract = updatedCheckpoint?.guidanceContract as GuidanceContract;
  assert.equal(updatedContract.intents?.[0].status, "in_progress");
  assert.ok(updatedContract.outOfScopeViolations?.includes("unrelated/secret/config.json"));
});

test("SPB Intent Ledger: concluding turn evaluation reprompts on partial completion and passes on full completion", () => {
  const sessionId = "test_ledger_gate_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Composite 4-step implementation",
    intents: [
      {
        id: "I1",
        text: "Fix API route for authentication",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/auth/route.ts"],
        acceptance: "API responds with 200",
        status: "open",
      },
      {
        id: "I2",
        text: "Add DB migration for profile table",
        kind: "explicit",
        layer: "data",
        targetFiles: ["src/lib/db/migrations/225_profile.sql"],
        acceptance: "Migration applies cleanly",
        status: "open",
      },
      {
        id: "I3",
        text: "Update UI form component with avatar upload",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/ProfileForm.tsx"],
        acceptance: "Avatar preview renders",
        status: "open",
      },
      {
        id: "I4",
        text: "Write integration test suite verifying login flow",
        kind: "explicit",
        layer: "test",
        targetFiles: ["tests/unit/auth.test.ts"],
        acceptance: "Tests pass with 100% assertions",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_2",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Case 1: Partial completion - Agent claims only 2 items (API and Data) with matching diff
  const partialDiff = {
    passed: true,
    actualModifiedFiles: ["src/app/api/auth/route.ts", "src/lib/db/migrations/225_profile.sql"],
    claimedFilesMissingInDiff: [],
  };

  const partialEval = evaluateLedgerCompletion(
    sessionId,
    "I have implemented the auth API route and added the DB migration.",
    partialDiff,
    true
  );

  assert.equal(partialEval.isSatisfied, false, "Should NOT satisfy when I3 and I4 are still open");
  assert.equal(partialEval.openItems.length, 2, "Should have 2 open items remaining");
  assert.equal(partialEval.openItems[0].id, "I3");
  assert.equal(partialEval.openItems[1].id, "I4");
  assert.ok(partialEval.suggestedReprompt?.includes("[I3]"));
  assert.ok(partialEval.suggestedReprompt?.includes("[I4]"));

  // Case 2: Full completion - All 4 items have matching diff evidence, and test command was executed
  const cpCase2 = getCheckpoint(sessionId);
  if (cpCase2?.guidanceContract) {
    const c = cpCase2.guidanceContract as GuidanceContract;
    if (c.intents?.[3]) {
      c.intents[3].evidence = "Executed test command";
      saveCheckpoint({ ...cpCase2, guidanceContract: c });
    }
  }

  const fullDiff = {
    passed: true,
    actualModifiedFiles: [
      "src/app/api/auth/route.ts",
      "src/lib/db/migrations/225_profile.sql",
      "src/components/ProfileForm.tsx",
      "tests/unit/auth.test.ts",
    ],
    claimedFilesMissingInDiff: [],
  };

  const fullEval = evaluateLedgerCompletion(
    sessionId,
    "All tasks are complete: auth route, db migration, profile form UI, and unit tests.",
    fullDiff,
    true
  );

  assert.equal(fullEval.isSatisfied, true, "Should satisfy when all 4 items are verified");
  assert.equal(fullEval.openItems.length, 0, "Zero open items should remain");
  assert.equal(fullEval.doneItems.length, 4, "All 4 items should be marked done");
});

test("SPB Intent Ledger: anti-stagnation stop rule marks items blocked after 2 consecutive unchanged reprompts", () => {
  const sessionId = "test_ledger_stagnation_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Hard task",
    intents: [
      {
        id: "I1",
        text: "Unresolvable legacy kernel bug",
        kind: "explicit",
        layer: "api",
        targetFiles: ["kernel.ts"],
        acceptance: "Passes memory leak test",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_3",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Reprompt 1: No change in open items
  const eval1 = evaluateLedgerCompletion(sessionId, "Tried to fix but got stuck", null, true);
  assert.equal(eval1.isSatisfied, false);
  assert.equal(eval1.isBlocked, false);

  // Reprompt 2: Still no change
  const eval2 = evaluateLedgerCompletion(sessionId, "Still cannot fix kernel bug", null, true);
  assert.equal(eval2.isSatisfied, false);
  assert.equal(eval2.isBlocked, false);

  // Reprompt 3: 2nd consecutive unchanged re-prompt -> triggers stop rule
  const eval3 = evaluateLedgerCompletion(sessionId, "Still cannot fix kernel bug", null, true);
  assert.equal(eval3.isBlocked, true, "Should mark blocked to break stagnation loop");
  assert.equal(
    eval3.isSatisfied,
    true,
    "Should yield satisfaction so bridge does not loop endlessly"
  );

  const finalCheckpoint = getCheckpoint(sessionId);
  const finalContract = finalCheckpoint?.guidanceContract as GuidanceContract;
  assert.equal(finalContract.intents?.[0].status, "blocked");
});

test("SPB Intent Ledger: gap analysis closes existing items with zero work generated", () => {
  const sessionId = "test_ledger_gap_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Inspect and update endpoints",
    intents: [
      {
        id: "I1",
        text: "Add login API route",
        kind: "explicit",
        layer: "api",
        acceptance: "Returns 200 on login",
        status: "open",
      },
      {
        id: "I2",
        text: "Add logout API route",
        kind: "explicit",
        layer: "api",
        acceptance: "Clears session cookies",
        status: "open",
      },
    ],
    observedReadFiles: ["src/app/api/auth/login.ts"],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_gap",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Agent inspects the repo and reports [I1: exists] and I2: missing
  const report =
    "Grounding inspection complete:\n" +
    "[I1: exists] The login API route is already implemented in src/app/api/auth/login.ts\n" +
    "[I2: missing] Logout route is not found and needs implementation.";

  const evalResult = evaluateLedgerCompletion(sessionId, report, null, true);

  const updatedCheckpoint = getCheckpoint(sessionId);
  const updatedContract = updatedCheckpoint?.guidanceContract as GuidanceContract;

  assert.equal(updatedContract.intents?.[0].gap, "exists");
  assert.equal(
    updatedContract.intents?.[0].status,
    "done_unverified",
    "Item 1 should be closed as done_unverified (verified via gap inspection)"
  );
  assert.equal(updatedContract.intents?.[1].gap, "missing");
  assert.equal(updatedContract.intents?.[1].status, "open", "Item 2 should remain open for work");
  assert.equal(evalResult.isSatisfied, false, "I2 is still open so it should re-prompt");
});

test("SPB Intent Ledger: remote proxy fallback marks in_progress items done_unverified when git diff is absent", () => {
  const sessionId = "test_ledger_remote_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Remote client task",
    intents: [
      {
        id: "I1",
        text: "Fix auth controller",
        kind: "explicit",
        layer: "api",
        targetFiles: ["auth.ts"],
        acceptance: "Validates payload",
        status: "in_progress",
        evidence: "Touched auth.ts via Edit",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_remote",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Empty git diff (e.g. client is running remotely, proxy cannot see client's local git tree)
  const emptyDiff = {
    passed: true,
    actualModifiedFiles: [],
    claimedFilesMissingInDiff: [],
  };

  const evalResult = evaluateLedgerCompletion(
    sessionId,
    "I have updated the auth controller and applied all required fixes.",
    emptyDiff,
    true
  );

  assert.equal(
    evalResult.isSatisfied,
    true,
    "Should not false-block remote clients when tool execution was observed"
  );
  assert.equal(evalResult.doneItems[0].status, "done_unverified");
});

test("SPB Intent Ledger: mixed prompt 'explain and then fix X' does not get stripped by non-actionable filter", () => {
  const prompt =
    "Can you explain why the database migration failed and then fix the syntax error in schema.sql";
  const ledger = decomposeRequestIntoLedger(prompt, 8);

  assert.ok(
    ledger.length > 0,
    "Mixed prompt containing action verb 'fix' must not be skipped as pure question"
  );
  assert.ok(ledger.some((i) => i.layer === "data" || i.layer === "api"));
});

test("SPB Intent Ledger: read-only tool calls do not mark items in_progress, and gate reprompts on conclusion", () => {
  const sessionId = "test_ledger_reads_not_work_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Inspect and update code",
    intents: [
      {
        id: "I1",
        text: "Update UI form component",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/Form.tsx"],
        acceptance: "Renders new fields",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_reads",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Simulate agent performing a read-only tool call
  const readExtraction = {
    text: "",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Read",
        args: JSON.stringify({ file_path: "src/components/Form.tsx" }),
      },
    ],
  };

  const obs = observeToolCallsOnLedger(sessionId, readExtraction);
  assert.equal(
    obs.updatedCount,
    0,
    "Read tool call must NEVER increment updatedCount or set in_progress"
  );

  const cpAfterRead = getCheckpoint(sessionId);
  const contractAfterRead = cpAfterRead?.guidanceContract as GuidanceContract;
  assert.equal(
    contractAfterRead.intents?.[0].status,
    "open",
    "Item must remain open after read-only inspection"
  );
  assert.ok(contractAfterRead.observedReadFiles?.includes("src/components/Form.tsx"));

  // Now simulate agent concluding without making edits
  const evalResult = evaluateLedgerCompletion(
    sessionId,
    "I inspected src/components/Form.tsx and everything looks ready.",
    null,
    true
  );

  assert.equal(
    evalResult.isSatisfied,
    false,
    "Gate must reject conclusion when only read-only actions occurred"
  );
  assert.equal(evalResult.openItems.length, 1);
});

test("SPB Intent Ledger: two items in same layer - one edit only completes exactly one item", () => {
  const sessionId = "test_ledger_layer_isolation_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Multiple API tasks",
    intents: [
      {
        id: "I1",
        text: "Add login endpoint",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/login/route.ts"],
        acceptance: "Login route works",
        status: "open",
      },
      {
        id: "I2",
        text: "Add reset password endpoint",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/reset/route.ts"],
        acceptance: "Reset route works",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_layer",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Only login route was modified in diff
  const diff = {
    passed: true,
    actualModifiedFiles: ["src/app/api/login/route.ts"],
    claimedFilesMissingInDiff: [],
  };

  const evalResult = evaluateLedgerCompletion(sessionId, "Added login endpoint", diff, true);

  assert.equal(
    evalResult.isSatisfied,
    false,
    "Must not satisfy when only 1 of 2 API items was modified"
  );
  assert.equal(evalResult.openItems.length, 1, "Exactly 1 item must remain open");
  assert.equal(evalResult.openItems[0].id, "I2", "I2 must remain open");
  assert.equal(evalResult.doneItems.length, 1, "Only I1 must be completed");
  assert.equal(evalResult.doneItems[0].id, "I1");
});

test("SPB Intent Ledger: baseline pre-existing dirty files at turn 1 do not count as agent work", () => {
  const sessionId = "test_ledger_baseline_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "New work on dirty tree",
    baselineModifiedFiles: ["src/app/api/dirty.ts"],
    intents: [
      {
        id: "I1",
        text: "Create new payment service",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/dirty.ts"],
        acceptance: "Payment service created",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_baseline",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Diff only shows the pre-existing dirty file
  const diff = {
    passed: true,
    actualModifiedFiles: ["src/app/api/dirty.ts"],
    claimedFilesMissingInDiff: [],
  };

  const evalResult = evaluateLedgerCompletion(
    sessionId,
    "Payment service is completed.",
    diff,
    true
  );

  assert.equal(
    evalResult.isSatisfied,
    false,
    "Pre-existing baseline dirty files must NOT satisfy new work"
  );
  assert.equal(evalResult.openItems.length, 1);
});

test("SPB Intent Ledger: non-test command 'git checkout latest' does not trigger test execution", () => {
  const sessionId = "test_ledger_git_checkout_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Test command validation",
    intents: [
      {
        id: "I1",
        text: "Run unit test suite",
        kind: "explicit",
        layer: "test",
        acceptance: "Tests pass",
        evidence: "Executed test command",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_git_checkout",
    taskPhase: "TESTING_AND_VERIFICATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Tool execution running git checkout latest (contains substring 'test')
  const extracted = {
    text: "",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Bash",
        args: JSON.stringify({ command: "git checkout latest" }),
      },
    ],
  };

  const obs = observeToolCallsOnLedger(sessionId, extracted);
  assert.equal(obs.updatedCount, 0, "git checkout latest must not match test command allowlist");

  const cp = getCheckpoint(sessionId);
  assert.equal((cp?.guidanceContract as GuidanceContract).intents?.[0].status, "open");
});

test("SPB Intent Ledger: pure advisory question 'How do I add auth' generates no execution ledger", () => {
  const prompt = "How do I add authentication and session handling to a Next.js application?";
  const ledger = decomposeRequestIntoLedger(prompt, 8);

  assert.equal(
    ledger.length,
    0,
    "Advisory question 'How do I add auth' must not create an execution ledger"
  );
});

test("SPB Intent Ledger: [I1: exists] with no prior read and no physical file is rejected and remains open", () => {
  const sessionId = "test_ledger_gap_reject_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Add custom auth",
    intents: [
      {
        id: "I1",
        text: "Create auth module",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/nonexistent/fake-auth-module.ts"],
        acceptance: "Exports auth handler",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_gap_reject",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Agent attempts to falsely claim the file exists without reading it or having it on disk
  const report =
    "Grounding check:\n" +
    "[I1: exists] The module is already at src/nonexistent/fake-auth-module.ts\n" +
    "Task finished.";

  const evalResult = evaluateLedgerCompletion(sessionId, report, null, true);

  const updatedCheckpoint = getCheckpoint(sessionId);
  const updatedContract = updatedCheckpoint?.guidanceContract as GuidanceContract;

  assert.equal(
    updatedContract.intents?.[0].status,
    "open",
    "Item 1 must remain open when cited file was never read and does not exist on disk"
  );
  assert.equal(
    evalResult.isSatisfied,
    false,
    "Must re-prompt agent rather than accepting false existence claim"
  );
});

test("SPB Intent Ledger: pre-existing dirty file edited further completes item via hash change", () => {
  const sessionId = "test_ledger_dirty_hash_" + Date.now();

  // Reference an existing file in the repo
  const targetFile = "tests/unit/spb-intent-ledger.test.ts";

  const contract: GuidanceContract = {
    taskSpecification: "Update test suite",
    intents: [
      {
        id: "I1",
        text: "Update intent ledger test suite",
        kind: "explicit",
        layer: "test",
        targetFiles: [targetFile],
        acceptance: "Tests pass",
        evidence: "Executed test command",
        status: "open",
      },
    ],
    baselineModifiedFiles: [targetFile],
    baselineFileHashes: {
      // Simulate that at Turn 1 the file had an older hash
      [targetFile]: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_dirty_hash",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  const diffReview = {
    passed: true,
    actualModifiedFiles: [targetFile],
    claimedFilesMissingInDiff: [],
  };

  const evalResult = evaluateLedgerCompletion(
    sessionId,
    "I updated the test suite with new assertions.",
    diffReview,
    true
  );

  const updatedCheckpoint = getCheckpoint(sessionId);
  const updatedContract = updatedCheckpoint?.guidanceContract as GuidanceContract;

  assert.equal(
    updatedContract.intents?.[0].status,
    "done",
    "Item must be marked done because the file's hash changed from the baseline snapshot"
  );
  assert.equal(evalResult.isSatisfied, true);
});

test("SPB Intent Ledger: bash write mutation moves item to in_progress", () => {
  const sessionId = "test_ledger_bash_mutation_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Create login form component",
    intents: [
      {
        id: "I1",
        text: "Implement LoginForm UI component",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/LoginForm.tsx"],
        acceptance: "Renders form fields",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_bash_write",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  const extracted = {
    text: "Writing login form via shell script",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Bash",
        args: JSON.stringify({
          command:
            "cat << 'EOF' > src/components/LoginForm.tsx\nexport function LoginForm() {}\nEOF",
        }),
      },
    ],
  };

  const obs = observeToolCallsOnLedger(sessionId, extracted);
  assert.equal(obs.updatedCount, 1, "Shell redirection must be recognized as mutating tool touch");

  const cp = getCheckpoint(sessionId);
  const updatedItem = (cp?.guidanceContract as GuidanceContract).intents?.[0];
  assert.equal(updatedItem?.status, "in_progress");
  assert.ok(
    updatedItem?.evidence?.includes("shell mutation") ||
      updatedItem?.evidence?.includes("shell command")
  );
});

test("SPB Intent Ledger: intermediate turn parses gap declarations while running tool calls", () => {
  const sessionId = "test_ledger_intermediate_gap_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Grounding and implementation",
    intents: [
      {
        id: "I1",
        text: "Verify existing button component",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/Button.tsx"],
        acceptance: "Button exists",
        status: "open",
      },
      {
        id: "I2",
        text: "Create modal dialog component",
        kind: "explicit",
        layer: "ui",
        targetFiles: ["src/components/Modal.tsx"],
        acceptance: "Modal dialog works",
        status: "open",
      },
    ],
    observedReadFiles: ["src/components/Button.tsx"],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_intermediate_gap",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  const extracted = {
    text: "Grounding inspection done: [I1: exists] in src/components/Button.tsx. Now starting I2.",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Write",
        args: JSON.stringify({ path: "src/components/Modal.tsx" }),
      },
    ],
  };

  const obs = observeToolCallsOnLedger(sessionId, extracted);
  assert.equal(
    obs.updatedCount,
    2,
    "Both I1 (via gap declaration) and I2 (via Write tool) should update"
  );

  const cp = getCheckpoint(sessionId);
  const items = (cp?.guidanceContract as GuidanceContract).intents || [];
  assert.equal(
    items[0].status,
    "done_unverified",
    "I1 should be done_unverified immediately from gap declaration"
  );
  assert.equal(items[1].status, "in_progress", "I2 should be in_progress from Write tool call");
});

test("SPB Intent Ledger: buildLedgerSummaryReport creates formatted summary on stagnation or budget exhaustion", () => {
  const intents = [
    {
      id: "I1",
      text: "Create login API route",
      kind: "explicit" as const,
      layer: "api" as const,
      acceptance: "Authenticates user credentials",
      status: "done" as const,
      evidence: "Verified via git diff",
    },
    {
      id: "I2",
      text: "Write unit tests",
      kind: "optional" as const,
      layer: "test" as const,
      acceptance: "100% test pass",
      status: "blocked" as const,
      evidence: "No progress detected across consecutive re-prompts",
    },
  ];

  const summary = buildLedgerSummaryReport(intents);
  assert.ok(summary.includes("[SPB Intent Ledger Summary]"));
  assert.ok(summary.includes("- [I1] (API) [explicit]: Create login API route -> Completed"));
  assert.ok(summary.includes("- [I2] (TEST) [optional]: Write unit tests -> Blocked / Incomplete"));
});

test("SPB Intent Ledger: shell commands with 2>&1, /dev/null, or external paths do not falsely mutate ledger items", () => {
  const sessionId = "test_ledger_shell_fp_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Backend API task",
    intents: [
      {
        id: "I1",
        text: "Implement backend route handler",
        kind: "explicit",
        layer: "api",
        targetFiles: ["src/app/api/auth/route.ts"],
        acceptance: "Handles requests",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_shell_fp",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Test command with 2>&1 and /dev/null redirect
  const extracted1 = {
    text: "Testing command output redirection",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Bash",
        args: JSON.stringify({ command: "curl -s http://localhost:3000 > /dev/null 2>&1" }),
      },
    ],
  };

  const obs1 = observeToolCallsOnLedger(sessionId, extracted1);
  assert.equal(obs1.updatedCount, 0, "2>&1 and /dev/null must not match as mutating file touch");

  // Test command writing to outside scratch directory
  const extracted2 = {
    text: "Writing temp log file",
    isStream: false,
    rawChunks: [],
    hasToolCalls: true,
    observedToolCalls: [
      {
        name: "Bash",
        args: JSON.stringify({ command: "echo 'debug' > /tmp/scratch.log" }),
      },
    ],
  };

  const obs2 = observeToolCallsOnLedger(sessionId, extracted2);
  assert.equal(obs2.updatedCount, 0, "Writing to /tmp must not match as project code mutation");

  const cp = getCheckpoint(sessionId);
  assert.equal(
    (cp?.guidanceContract as GuidanceContract).intents?.[0].status,
    "open",
    "Item must remain open after shell false positive commands"
  );
});

test("SPB Intent Ledger: test item stays in_progress when test file is modified without test command execution", () => {
  const sessionId = "test_ledger_test_pending_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Add integration tests",
    intents: [
      {
        id: "I1",
        text: "Create test suite for auth",
        kind: "explicit",
        layer: "test",
        targetFiles: ["tests/unit/auth.test.ts"],
        acceptance: "Unit tests pass with 100% assertions",
        status: "open",
      },
    ],
    requireTestPassBeforeDone: true,
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_test_pending",
    taskPhase: "TESTING_AND_VERIFICATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Agent modified the test file on disk, but has NOT run tests yet
  const diffReview = {
    passed: true,
    actualModifiedFiles: ["tests/unit/auth.test.ts"],
    claimedFilesMissingInDiff: [],
  };

  const evalResult = evaluateLedgerCompletion(
    sessionId,
    "I have written the test file tests/unit/auth.test.ts.",
    diffReview,
    true
  );

  const updatedCheckpoint = getCheckpoint(sessionId);
  const updatedContract = updatedCheckpoint?.guidanceContract as GuidanceContract;

  assert.equal(
    updatedContract.intents?.[0].status,
    "in_progress",
    "Test item must stay in_progress pending test runner execution"
  );
  assert.ok(
    updatedContract.intents?.[0].evidence?.includes("Pending test execution"),
    "Evidence must state test execution is pending"
  );
  assert.equal(evalResult.isSatisfied, false, "Must re-prompt until test runner execution occurs");
});

test("SPB Intent Ledger: default maxReprompts: 2 deterministically triggers blocked status and stagnation report", () => {
  const sessionId = "test_ledger_budget_stagnation_" + Date.now();

  const contract: GuidanceContract = {
    taskSpecification: "Implement stubborn feature",
    intents: [
      {
        id: "I1",
        text: "Complex distributed lock",
        kind: "explicit",
        layer: "api",
        acceptance: "Lock acquires and releases cleanly",
        status: "open",
      },
    ],
    strictCompletion: true,
  };

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_budget_stagnation",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_2_resilient",
    guidanceContract: contract,
    consecutiveReads: 0,
    createdAt: Date.now(),
  });

  // Turn 0: initial concluding attempt (no work done, no diff)
  const eval0 = evaluateLedgerCompletion(sessionId, "I cannot find the lock.", null, true);
  assert.equal(eval0.isSatisfied, false);
  assert.equal(eval0.isBlocked, false);

  // Turn 1: reprompt 1 returns with identical conclusion text (no progress)
  const eval1 = evaluateLedgerCompletion(sessionId, "Still cannot find the lock.", null, true);
  assert.equal(eval1.isSatisfied, false);
  assert.equal(eval1.isBlocked, false);

  // Turn 2: reprompt 2 returns with identical conclusion text (consecutiveNoChange reaches 2)
  const eval2 = evaluateLedgerCompletion(sessionId, "Still cannot find the lock.", null, true);
  assert.equal(eval2.isBlocked, true, "Must deterministically transition to blocked at threshold");
  assert.equal(eval2.isSatisfied, true, "isSatisfied is true when blocked to halt the loop");

  const finalCheckpoint = getCheckpoint(sessionId);
  const finalContract = finalCheckpoint?.guidanceContract as GuidanceContract;
  assert.equal(finalContract.intents?.[0].status, "blocked");
  assert.ok(finalContract.intents?.[0].evidence?.includes("No progress detected"));

  const summary = buildLedgerSummaryReport(finalContract.intents || []);
  assert.ok(summary.includes("Blocked / Incomplete: No progress detected"));
});

test("SPB Intent Ledger: updateGuidanceContract atomically updates contract without clobbering checkpoint fields", () => {
  const sessionId = "test_ledger_atomic_update_" + Date.now();
  const initialCreatedAt = 1700000000000;

  saveCheckpoint({
    sessionId,
    promptAnchorHash: "anchor_atomic",
    taskPhase: "CODE_GENERATION",
    modelTier: "tier_1_apex",
    statePayload: JSON.stringify({ satisfactionScore: 0.95, customParam: "preserved" }),
    guidanceContract: {
      intents: [
        {
          id: "I1",
          status: "open",
          text: "Task 1",
          kind: "explicit",
          layer: "api",
          acceptance: "Works",
        },
      ],
    },
    consecutiveReads: 3,
    stagnationRecovered: 1,
    createdAt: initialCreatedAt,
  });

  const updatedContract: GuidanceContract = {
    intents: [
      {
        id: "I1",
        status: "done",
        text: "Task 1",
        kind: "explicit",
        layer: "api",
        acceptance: "Works",
      },
    ],
  };

  const success = updateGuidanceContract(sessionId, updatedContract);
  assert.equal(success, true);

  const cp = getCheckpoint(sessionId);
  assert.ok(cp);
  assert.equal(cp.createdAt, initialCreatedAt, "createdAt must NOT be clobbered");
  assert.equal(cp.consecutiveReads, 3, "consecutiveReads must NOT be clobbered");
  assert.equal(cp.modelTier, "tier_1_apex", "modelTier must NOT be clobbered");

  const parsedPayload = JSON.parse(cp.statePayload);
  assert.equal(
    parsedPayload.satisfactionScore,
    0.95,
    "statePayload satisfactionScore must be preserved"
  );
  assert.equal(
    parsedPayload.customParam,
    "preserved",
    "statePayload custom parameters must be preserved"
  );

  const contractResult = cp.guidanceContract as GuidanceContract;
  assert.equal(
    contractResult.intents?.[0].status,
    "done",
    "guidanceContract must be atomically updated"
  );
});

test("SPB Intent Ledger: resolveSessionLifecycle handles continuation, amendment, and new task with state archival", () => {
  const existingContract: GuidanceContract = {
    taskSpecification: "Initial task",
    intents: [
      {
        id: "I1",
        text: "Create user model",
        kind: "explicit",
        layer: "data",
        acceptance: "Model created",
        status: "done",
      },
      {
        id: "I2",
        text: "Implement login route",
        kind: "explicit",
        layer: "api",
        acceptance: "Route works",
        status: "blocked",
      },
    ],
    consecutiveNoChangeReprompts: 2,
    strictCompletion: true,
  };

  // Case 1: Continuation
  const resCont = resolveSessionLifecycle(existingContract, "Please continue and finish the rest");
  assert.equal(resCont.action, "continuation");
  assert.equal(
    resCont.contract.intents?.[1].status,
    "open",
    "Blocked item must be re-opened for work"
  );
  assert.equal(resCont.contract.consecutiveNoChangeReprompts, 0);
  assert.ok(resCont.directive?.includes("SPB Continuation Directive"));

  // Case 2: Amendment (skipping item)
  const resAmend = resolveSessionLifecycle(
    existingContract,
    "Actually skip login route and also add password reset"
  );
  assert.equal(resAmend.action, "amendment");
  const loginItem = resAmend.contract.intents?.find((i) => i.id === "I2");
  assert.equal(loginItem?.status, "skipped", "Cancelled item must be marked skipped");
  const addedItem = resAmend.contract.intents?.find((i) => i.text.includes("password reset"));
  assert.ok(addedItem, "New item must be appended to the ledger");

  // Case 3: New task when all prior items are done
  const completedContract: GuidanceContract = {
    taskSpecification: "Completed auth task",
    intents: [
      {
        id: "I1",
        text: "Task 1",
        kind: "explicit",
        layer: "api",
        acceptance: "Done",
        status: "done",
      },
      {
        id: "I2",
        text: "Task 2",
        kind: "explicit",
        layer: "ui",
        acceptance: "Done",
        status: "done",
      },
    ],
    strictCompletion: true,
  };

  const resNew = resolveSessionLifecycle(completedContract, "Build invoice generation system");
  assert.equal(resNew.action, "new_task");
  assert.equal(resNew.contract.taskSpecification, "Build invoice generation system");
  assert.ok(
    Array.isArray(resNew.contract.archivedContracts),
    "Prior completed work must be archived"
  );
  assert.equal((resNew.contract.archivedContracts as unknown[]).length, 1);
});

test("SPB Intent Ledger: expandIntentLedgerApex discovers unspoken SDLC requirements and caches by prompt anchor hash", () => {
  const prompt = "Create a registration form component with avatar upload";
  const anchorHash = "anchor_apex_eval_" + Date.now();

  const firstPass = expandIntentLedgerApex(prompt, anchorHash, 8);

  assert.ok(firstPass.length >= 2, "Apex expansion must extract both explicit and unspoken items");

  const uiItem = firstPass.find((i) => i.layer === "ui" && i.kind === "explicit");
  assert.ok(uiItem, "Must identify UI component");

  const validationItem = firstPass.find(
    (i) => i.layer === "ui" && i.kind === "required-implied" && i.parentId === uiItem?.id
  );
  assert.ok(validationItem, "Apex expansion must infer client validation and error states");

  // Second pass with same prompt anchor hash must return cached result
  const secondPass = expandIntentLedgerApex(prompt, anchorHash, 8);
  assert.equal(secondPass.length, firstPass.length, "Cached pass must return identical count");
  assert.equal(secondPass[0].id, firstPass[0].id);
});
