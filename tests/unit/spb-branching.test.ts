import test from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  saveBranchCheckpoint,
  getBranchCheckpoint,
  listBranchCheckpoints,
  markBranchMerged,
  deleteBranchCheckpoint,
  __resetSpbBranchInitForTests,
} from "../../src/lib/db/spbBranchState.ts";
import {
  createAgenticConversation,
  insertConversationTurnNodes,
} from "../../src/lib/db/agenticConversations.ts";
import {
  forkSession,
  createContinuationFrame,
  mergeBranchArtifact,
} from "../../open-sse/services/spb/branchManager.ts";

test.after(() => {
  __resetSpbBranchInitForTests();
  resetDbInstance();
});

test("spbBranchState: CRUD operations for branch checkpoints", () => {
  const branchId = `br_test_${Date.now()}`;
  const parentSessionId = `parent_sess_${Date.now()}`;
  const anchorHash = "sha256:abc1234567890def";
  const capsule = JSON.stringify({
    activeGoal: "Implement authentication gate",
    verifiedFacts: { "/src/auth.ts": "referenced" },
    activeDependencies: [],
    dirtyWorkingFiles: [],
    lastExecutionOutcome: { exitCode: 0, primaryDiagnostic: "ok" },
    nextActionDirectives: ["Run unit tests"],
  });

  // Save checkpoint
  const saved = saveBranchCheckpoint({
    branchId,
    parentSessionId,
    anchorTurnHash: anchorHash,
    activeCapsule: capsule,
    mergedAt: null,
    createdAt: Date.now(),
  });
  assert.equal(saved, true);

  // Retrieve checkpoint
  const retrieved = getBranchCheckpoint(branchId);
  assert.ok(retrieved);
  assert.equal(retrieved.branchId, branchId);
  assert.equal(retrieved.parentSessionId, parentSessionId);
  assert.equal(retrieved.anchorTurnHash, anchorHash);
  assert.equal(retrieved.mergedAt, null);

  // List checkpoints
  const list = listBranchCheckpoints(parentSessionId);
  assert.ok(list.length >= 1);
  assert.ok(list.some((b) => b.branchId === branchId));

  // Mark merged
  const merged = markBranchMerged(branchId, Date.now());
  assert.equal(merged, true);

  const afterMerge = getBranchCheckpoint(branchId);
  assert.ok(afterMerge);
  assert.ok(typeof afterMerge.mergedAt === "number");

  // Delete
  const deleted = deleteBranchCheckpoint(branchId);
  assert.equal(deleted, true);
  assert.equal(getBranchCheckpoint(branchId), null);
});

test("branchManager: forkSession creates forked context and persists checkpoint", async () => {
  const parentSessionId = `sess_${Date.now()}`;
  const forkPointHash = "turn_node_hash_001";

  // Create parent conversation and node so turn index resolves
  createAgenticConversation({
    id: parentSessionId,
    apiKeyId: null,
    fingerprintHash: `fp_${Date.now()}`,
  });

  insertConversationTurnNodes(parentSessionId, "corr_test", [
    {
      id: forkPointHash,
      parentId: null,
      role: "user",
      contentHash: "hash_001",
    },
  ]);

  const messages = [
    {
      role: "user",
      content: "Design architecture and outline components for payment gateway in /src/payment.ts",
    },
  ];

  const forked = await forkSession({
    parentSessionId,
    forkPointHash,
    branchMode: "continuation",
    pruneLegacy: true,
    currentMessages: messages,
  });

  assert.ok(forked.branchId.startsWith("br_"));
  assert.equal(forked.parentSessionId, parentSessionId);
  assert.equal(forked.forkPointHash, forkPointHash);
  assert.ok(forked.capsule);
  assert.ok(forked.capsule.activeGoal.length > 0);
  assert.ok(Array.isArray(forked.continuationFrame));
  assert.ok(forked.continuationFrame.length > 0);

  // Verify checkpoint was persisted
  const checkpoint = getBranchCheckpoint(forked.branchId);
  assert.ok(checkpoint);
  assert.equal(checkpoint.parentSessionId, parentSessionId);

  // Clean up
  deleteBranchCheckpoint(forked.branchId);
});

test("branchManager: createContinuationFrame throws error on non-existent turn node", async () => {
  const parentSessionId = `sess_missing_${Date.now()}`;
  const nonExistentHash = "turn_does_not_exist";

  createAgenticConversation({
    id: parentSessionId,
    apiKeyId: null,
    fingerprintHash: `fp_${Date.now()}`,
  });

  await assert.rejects(async () => {
    await createContinuationFrame(
      parentSessionId,
      nonExistentHash,
      { branchMode: "continuation", pruneLegacy: true, forkPointHash: nonExistentHash },
      []
    );
  }, /Fork point hash/);
});

test("branchManager: mergeBranchArtifact marks branch as merged", async () => {
  const branchId = `br_merge_${Date.now()}`;
  saveBranchCheckpoint({
    branchId,
    parentSessionId: "parent_123",
    anchorTurnHash: "turn_123",
    activeCapsule: "{}",
    mergedAt: null,
    createdAt: Date.now(),
  });

  const merged = await mergeBranchArtifact(branchId, { patch: "diff content" });
  assert.equal(merged, true);

  const updated = getBranchCheckpoint(branchId);
  assert.ok(updated);
  assert.ok(typeof updated.mergedAt === "number");

  deleteBranchCheckpoint(branchId);
});
