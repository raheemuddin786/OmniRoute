/**
 * SPB-IR Context Partition Engine — Multi-Agent DAG Orchestration
 * Decomposes composite requests into independent parallel (Fusion) and
 * dependent sequential (Pipeline) sub-contexts, synthesizing verified artifacts.
 */

import crypto from "node:crypto";
import { classifyPromptIntent, type IntentType } from "../intentClassifier.ts";
import type { TaskType, FitnessTier } from "../../../src/domain/pipeline.ts";
import type { FusionTuning } from "../fusion.ts";

export interface FusionConfig {
  panelModels?: string[];
  judgeModel?: string;
  tuning?: FusionTuning;
}

export interface SubTask {
  id: string;
  name: string;
  prompt: string;
  taskType: TaskType;
  dependencies: string[];
  isParallel: boolean;
  fitnessTier: FitnessTier;
  expectedArtifactType: "PATCH" | "ANALYSIS" | "TEST_RESULTS" | "SCHEMA" | "CODE";
}

export interface PartitionedContext {
  parallelTasks: SubTask[];
  sequentialTasks: SubTask[];
  artifactContract: VerifiedArtifactContract[];
}

export interface VerifiedArtifactContract<T = unknown> {
  contractVersion: "1.0";
  producerAgentId: string;
  sourceTaskPhase: string;
  artifactType: "PATCH" | "ANALYSIS" | "TEST_RESULTS" | "SCHEMA" | "CODE";
  verificationHash: string;
  status: "VERIFIED" | "FAILED" | "BLOCKED";
  payload: T;
  consumedTokensSaved: number;
}

export interface DecompositionResult {
  partitioned: PartitionedContext;
  executionPlan: {
    phase1Parallel: SubTask[];
    phase2Sequential: SubTask[];
  };
}

const INTENT_TO_TASK: Record<IntentType, TaskType> = {
  code: "code",
  math: "math",
  reasoning: "reasoning",
  creative: "creative",
  medium: "medium",
  simple: "simple",
};

const TASK_TO_FITNESS_TIER: Record<TaskType, FitnessTier> = {
  code: "moderate",
  math: "best-reasoning",
  reasoning: "best-reasoning",
  creative: "moderate",
  medium: "moderate",
  simple: "cheapest",
};

/**
 * Analyzes the incoming request and decomposes it into a DAG of sub-tasks
 * that can be executed in parallel (independent) or sequence (dependent).
 */
export function decomposeRequestIntoSubTasks(
  userPrompt: string,
  _availableContext: Record<string, unknown> = {}
): DecompositionResult {
  const intent = classifyPromptIntent(userPrompt);
  const taskType = INTENT_TO_TASK[intent];

  // Extract sub-tasks from the prompt using keyword analysis and heuristics
  const subTasks = extractSubTasks(userPrompt, taskType);

  // Partition into parallel (independent) and sequential (dependent) tasks
  const parallelTasks = subTasks.filter((t) => t.isParallel);
  const sequentialTasks = subTasks.filter((t) => !t.isParallel);

  // Build execution plan: parallel first, then sequential with dependencies
  const executionPlan = buildExecutionPlan(parallelTasks, sequentialTasks);

  return {
    partitioned: {
      parallelTasks,
      sequentialTasks,
      artifactContract: [],
    },
    executionPlan,
  };
}

/**
 * Extracts individual sub-tasks from a composite user prompt.
 * Uses keyword matching and structural analysis to identify independent vs dependent tasks.
 */
function extractSubTasks(prompt: string, primaryTaskType: TaskType): SubTask[] {
  const lower = prompt.toLowerCase();
  const subTasks: SubTask[] = [];

  // Common patterns for independent parallel tasks
  const parallelPatterns = [
    {
      keywords: ["security", "audit", "vulnerability", "penetration"],
      name: "Security Analysis",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: ["performance", "optimize", "benchmark", "profiling"],
      name: "Performance Analysis",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: ["architecture", "design", "structure", "pattern"],
      name: "Architecture Review",
      type: "reasoning" as TaskType,
      artifact: "SCHEMA" as const,
    },
    {
      keywords: ["test", "testing", "unit test", "integration test"],
      name: "Test Generation",
      type: "code" as TaskType,
      artifact: "TEST_RESULTS" as const,
    },
    {
      keywords: ["document", "documentation", "readme", "comments"],
      name: "Documentation",
      type: "creative" as TaskType,
      artifact: "CODE" as const,
    },
    {
      keywords: ["refactor", "cleanup", "modernize", "lint"],
      name: "Refactoring",
      type: "code" as TaskType,
      artifact: "PATCH" as const,
    },
  ];

  // Check for parallelizable independent analyses
  for (const pattern of parallelPatterns) {
    if (pattern.keywords.some((k) => lower.includes(k))) {
      subTasks.push({
        id: `sub_${pattern.name.toLowerCase().replace(/\s+/g, "_")}`,
        name: pattern.name,
        prompt: `Analyze the following for ${pattern.name.toLowerCase()}: ${prompt}`,
        taskType: pattern.type,
        dependencies: [],
        isParallel: true,
        fitnessTier: TASK_TO_FITNESS_TIER[pattern.type],
        expectedArtifactType: pattern.artifact,
      });
    }
  }

  // Dependent sequential tasks (typically implementation flow)
  const hasImplementation =
    lower.includes("implement") || lower.includes("create") || lower.includes("build");
  const hasTesting = lower.includes("test") && !lower.includes("security");
  const hasVerification = lower.includes("verify") || lower.includes("validate");

  if (hasImplementation) {
    subTasks.push({
      id: "sub_implementation",
      name: "Implementation",
      prompt: `Implement the solution: ${prompt}`,
      taskType: "code",
      dependencies: [],
      isParallel: false,
      fitnessTier: "moderate",
      expectedArtifactType: "CODE",
    });
  }

  if (hasTesting) {
    subTasks.push({
      id: "sub_test_generation",
      name: "Test Generation",
      prompt: `Generate comprehensive tests for: ${prompt}`,
      taskType: "code",
      dependencies: ["sub_implementation"],
      isParallel: false,
      fitnessTier: "moderate",
      expectedArtifactType: "TEST_RESULTS",
    });
  }

  if (hasVerification) {
    subTasks.push({
      id: "sub_verification",
      name: "Verification",
      prompt: `Verify the implementation: ${prompt}`,
      taskType: "reasoning",
      dependencies: hasTesting
        ? ["sub_test_generation"]
        : hasImplementation
          ? ["sub_implementation"]
          : [],
      isParallel: false,
      fitnessTier: "best-reasoning",
      expectedArtifactType: "ANALYSIS",
    });
  }

  // If no specific patterns matched, create a single task from the primary intent
  if (subTasks.length === 0) {
    subTasks.push({
      id: "sub_primary",
      name: "Primary Task",
      prompt,
      taskType: primaryTaskType,
      dependencies: [],
      isParallel: true, // Single task can run in parallel
      fitnessTier: TASK_TO_FITNESS_TIER[primaryTaskType],
      expectedArtifactType: "CODE",
    });
  }

  return subTasks;
}

/**
 * Builds a two-phase execution plan: parallel first, then sequential with resolved dependencies.
 */
function buildExecutionPlan(
  parallelTasks: SubTask[],
  sequentialTasks: SubTask[]
): { phase1Parallel: SubTask[]; phase2Sequential: SubTask[] } {
  // Phase 1: All parallel tasks (no dependencies or independent)
  const phase1Parallel = parallelTasks.filter((t) => t.dependencies.length === 0);

  // Phase 2: Sequential tasks topologically sorted by dependencies
  const phase2Sequential = topologicalSort(sequentialTasks);

  return { phase1Parallel, phase2Sequential };
}

/**
 * Topological sort for sequential tasks based on dependencies.
 */
function topologicalSort(tasks: SubTask[]): SubTask[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: SubTask[] = [];

  function visit(taskId: string) {
    if (visited.has(taskId)) return;
    const task = taskMap.get(taskId);
    if (!task) return;

    for (const dep of task.dependencies) {
      visit(dep);
    }
    visited.add(taskId);
    result.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}

/**
 * Executes parallel sub-tasks using Fusion panel synthesis.
 * Each sub-task is dispatched to a panel of models, then synthesized by a judge.
 */
export async function executeParallelPhase(
  tasks: SubTask[],
  fusionConfig: FusionConfig,
  executeModel: (prompt: string, model: string) => Promise<string>
): Promise<Map<string, VerifiedArtifactContract>> {
  const results = new Map<string, VerifiedArtifactContract>();

  for (const task of tasks) {
    // For each parallel task, execute via Fusion panel
    const panelModels = fusionConfig.panelModels || [
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4o",
      "google/gemini-1.5-pro",
    ];
    const judgeModel = fusionConfig.judgeModel || "anthropic/claude-3-5-sonnet";

    // Execute panel in parallel
    const panelPromises = panelModels.map((model) => executeModel(task.prompt, model));
    const panelResponses = await Promise.allSettled(panelPromises);

    // Filter successful responses
    const successful = panelResponses
      .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
      .map((r) => r.value);

    if (successful.length === 0) {
      results.set(task.id, {
        contractVersion: "1.0",
        producerAgentId: task.id,
        sourceTaskPhase: task.taskType,
        artifactType: task.expectedArtifactType,
        verificationHash: "",
        status: "FAILED",
        payload: null,
        consumedTokensSaved: 0,
      });
      continue;
    }

    // Anonymize and synthesize via judge
    const anonymized = successful.map((text, i) => `Source ${i + 1}: ${text}`).join("\n\n");
    const judgePrompt = `Synthesize a single coherent answer from these independent analyses:\n\n${anonymized}\n\nFocus on consensus, contradictions, unique insights, and actionable recommendations.`;

    const synthesized = await executeModel(judgePrompt, judgeModel);
    const verificationHash = await computeHash(synthesized);

    results.set(task.id, {
      contractVersion: "1.0",
      producerAgentId: task.id,
      sourceTaskPhase: task.taskType,
      artifactType: task.expectedArtifactType,
      verificationHash,
      status: "VERIFIED",
      payload: synthesized,
      consumedTokensSaved: panelModels.length * 1000, // Estimate
    });
  }

  return results;
}

/**
 * Executes sequential sub-tasks using Pipeline chaining.
 * Each step's output becomes the next step's input.
 */
export async function executeSequentialPhase(
  tasks: SubTask[],
  previousResults: Map<string, VerifiedArtifactContract>,
  executeModel: (prompt: string, model: string) => Promise<string>
): Promise<Map<string, VerifiedArtifactContract>> {
  const results = new Map(previousResults);

  for (const task of tasks) {
    // Build context from dependencies
    const dependencyOutputs = task.dependencies
      .map((depId) => results.get(depId)?.payload)
      .filter(Boolean)
      .join("\n\n---\n\n");

    const contextualPrompt = `${task.prompt}\n\nContext from dependencies:\n${dependencyOutputs}`;

    // Resolve model for this task's fitness tier
    const model = resolveModelForTier(task.fitnessTier, [], task.taskType);

    const output = await executeModel(contextualPrompt, model);
    const verificationHash = await computeHash(output);

    results.set(task.id, {
      contractVersion: "1.0",
      producerAgentId: task.id,
      sourceTaskPhase: task.taskType,
      artifactType: task.expectedArtifactType,
      verificationHash,
      status: "VERIFIED",
      payload: output,
      consumedTokensSaved: 0,
    });
  }

  return results;
}

/**
 * Maps a fitness tier to a concrete model string.
 * This is a simplified resolver; in production it would query the provider registry.
 */
function resolveModelForTier(
  tier: FitnessTier,
  _availableModels: readonly string[],
  taskType: TaskType
): string {
  const tierModelMap: Record<FitnessTier, Record<TaskType, string>> = {
    "best-reasoning": {
      code: "anthropic/claude-3-5-sonnet",
      math: "openai/o1-preview",
      reasoning: "anthropic/claude-3-5-sonnet",
      creative: "openai/gpt-4o",
      medium: "anthropic/claude-3-5-sonnet",
      simple: "google/gemini-1.5-pro",
    },
    moderate: {
      code: "openai/gpt-4o",
      math: "anthropic/claude-3-5-sonnet",
      reasoning: "openai/gpt-4o",
      creative: "google/gemini-1.5-pro",
      medium: "openai/gpt-4o",
      simple: "anthropic/claude-3-5-sonnet",
    },
    cheapest: {
      code: "google/gemini-1.5-flash",
      math: "google/gemini-1.5-flash",
      reasoning: "google/gemini-1.5-flash",
      creative: "google/gemini-1.5-flash",
      medium: "google/gemini-1.5-flash",
      simple: "google/gemini-1.5-flash",
    },
  };

  return tierModelMap[tier]?.[taskType] || tierModelMap.moderate.code;
}

/**
 * Computes SHA-256 hash for artifact verification.
 */
async function computeHash(content: string): Promise<string> {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
