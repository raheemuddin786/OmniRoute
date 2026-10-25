import test from "node:test";
import assert from "node:assert/strict";
import {
  decomposeRequestIntoSubTasks,
  executeParallelPhase,
  executeSequentialPhase,
  type SubTask,
} from "../../open-sse/services/spb/contextPartition.ts";

test("contextPartition: decomposes composite request into parallel and sequential sub-tasks", () => {
  const prompt =
    "Implement a secure payment gateway in TypeScript with unit tests, security audit, and verification.";
  const result = decomposeRequestIntoSubTasks(prompt);

  assert.ok(result.partitioned);
  assert.ok(result.executionPlan);

  // Parallel tasks: Security Analysis should be detected as independent parallel task
  const parallelTasks = result.partitioned.parallelTasks;
  assert.ok(parallelTasks.length >= 1);
  const securityTask = parallelTasks.find((t) => t.name.includes("Security"));
  assert.ok(securityTask);
  assert.equal(securityTask.isParallel, true);

  // Sequential tasks: Implementation, Test Generation, Verification
  const sequentialTasks = result.partitioned.sequentialTasks;
  assert.ok(sequentialTasks.length >= 1);
  const implTask = sequentialTasks.find((t) => t.name.includes("Implementation"));
  assert.ok(implTask);

  const testTask = sequentialTasks.find((t) => t.name.includes("Test"));
  if (testTask) {
    assert.ok(testTask.dependencies.includes(implTask.id));
  }

  // Execution plan checks
  assert.ok(Array.isArray(result.executionPlan.phase1Parallel));
  assert.ok(Array.isArray(result.executionPlan.phase2Sequential));
});

test("contextPartition: handles single simple prompt without crashing", () => {
  const prompt = "What is the capital of France?";
  const result = decomposeRequestIntoSubTasks(prompt);

  assert.ok(result.partitioned);
  assert.ok(
    result.partitioned.parallelTasks.length > 0 || result.partitioned.sequentialTasks.length > 0
  );
});

test("contextPartition: executeParallelPhase runs parallel tasks and synthesizes via judge", async () => {
  const tasks: SubTask[] = [
    {
      id: "sub_security_1",
      name: "Security Audit",
      prompt: "Analyze the cryptographic safety of SHA-256 vs SHA-1.",
      taskType: "reasoning",
      dependencies: [],
      isParallel: true,
      fitnessTier: "best-reasoning",
      expectedArtifactType: "ANALYSIS",
    },
  ];

  const executedCalls: Array<{ prompt: string; model: string }> = [];
  const mockExecuteModel = async (prompt: string, model: string): Promise<string> => {
    executedCalls.push({ prompt, model });
    if (prompt.includes("Synthesize")) {
      return "Synthesized Judge Verdict: SHA-256 is cryptographically secure.";
    }
    return `Panel response from ${model}: SHA-256 has no known collisions.`;
  };

  const fusionConfig = {
    panelModels: ["model-a", "model-b"],
    judgeModel: "judge-model",
  };

  const artifacts = await executeParallelPhase(tasks, fusionConfig, mockExecuteModel);
  assert.equal(artifacts.size, 1);

  const contract = artifacts.get("sub_security_1");
  assert.ok(contract);
  assert.equal(contract.status, "VERIFIED");
  assert.equal(contract.artifactType, "ANALYSIS");
  assert.ok(typeof contract.payload === "string");
  assert.ok((contract.payload as string).includes("Synthesized Judge Verdict"));
  assert.ok(contract.verificationHash.length === 64);
});

test("contextPartition: executeSequentialPhase executes dependent tasks with context from previous results", async () => {
  const previousResults = new Map();
  previousResults.set("sub_step_1", {
    contractVersion: "1.0",
    producerAgentId: "sub_step_1",
    sourceTaskPhase: "code",
    artifactType: "CODE",
    verificationHash: "hash_step_1",
    status: "VERIFIED",
    payload: "export function authenticate(token: string) { return Boolean(token); }",
    consumedTokensSaved: 0,
  });

  const tasks: SubTask[] = [
    {
      id: "sub_step_2",
      name: "Test Generation",
      prompt: "Write unit test for the authenticate function.",
      taskType: "code",
      dependencies: ["sub_step_1"],
      isParallel: false,
      fitnessTier: "moderate",
      expectedArtifactType: "TEST_RESULTS",
    },
  ];

  let receivedPrompt = "";
  const mockExecuteModel = async (prompt: string, _model: string): Promise<string> => {
    receivedPrompt = prompt;
    return "test('authenticate returns true for valid token', () => { assert.equal(authenticate('ok'), true); });";
  };

  const results = await executeSequentialPhase(tasks, previousResults, mockExecuteModel);
  assert.equal(results.size, 2);

  const step2Contract = results.get("sub_step_2");
  assert.ok(step2Contract);
  assert.equal(step2Contract.status, "VERIFIED");
  assert.equal(step2Contract.artifactType, "TEST_RESULTS");
  assert.ok(receivedPrompt.includes("Context from dependencies:"));
  assert.ok(receivedPrompt.includes("export function authenticate"));
});
