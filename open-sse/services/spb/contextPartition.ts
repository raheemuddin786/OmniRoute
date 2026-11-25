/**
 * SPB-IR Context Partition Engine — Multi-Agent DAG Orchestration
 * Decomposes composite requests into independent parallel (Fusion) and
 * dependent sequential (Pipeline) sub-contexts, synthesizing verified artifacts.
 */

import crypto from "node:crypto";
import { classifyPromptIntent, type IntentType } from "../intentClassifier.ts";
import type { TaskType, FitnessTier } from "../../../src/domain/pipeline.ts";
import type { FusionTuning } from "../fusion.ts";
import type { IntentLedgerItem, IntentLayer, GuidanceContract } from "./intentAnalyzer.ts";
import { getLearnedOptimization, saveLearnedOptimization } from "../../../src/lib/db/spbState.ts";

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
      keywords: ["security", "audit", "vulnerability", "penetration", "threat", "scan"],
      name: "Security Analysis",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: ["performance", "optimize", "benchmark", "profiling", "measure", "efficiency"],
      name: "Performance Analysis",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: [
        "architecture",
        "design",
        "structure",
        "pattern",
        "design pattern",
        "system architecture",
      ],
      name: "Architecture Review",
      type: "reasoning" as TaskType,
      artifact: "SCHEMA" as const,
    },
    {
      keywords: ["test", "testing", "unit test", "integration test", "assert", "coverage", "spec"],
      name: "Test Generation",
      type: "code" as TaskType,
      artifact: "TEST_RESULTS" as const,
    },
    {
      keywords: ["document", "documentation", "readme", "comments", "docstring", "api doc"],
      name: "Documentation",
      type: "creative" as TaskType,
      artifact: "CODE" as const,
    },
    {
      keywords: ["refactor", "cleanup", "modernize", "lint", "reorganize", "restructure"],
      name: "Refactoring",
      type: "code" as TaskType,
      artifact: "PATCH" as const,
    },
    {
      keywords: ["fix", "bug", "issue", "error", "bug fix", "debug", "resolve"],
      name: "Bug Fix",
      type: "code" as TaskType,
      artifact: "PATCH" as const,
    },
    {
      keywords: ["implement", "add", "create", "build", "write", "generate", "new feature"],
      name: "Implementation",
      type: "code" as TaskType,
      artifact: "CODE" as const,
    },
    {
      keywords: ["verify", "validate", "check", "inspect", "review", "analysis"],
      name: "Verification",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: ["analysis", "analyze", "investigate", "explore", "study", "examine"],
      name: "Analysis",
      type: "reasoning" as TaskType,
      artifact: "ANALYSIS" as const,
    },
    {
      keywords: ["run", "execute", "execute test", "run script", "execute command", "shell"],
      name: "Execution",
      type: "creative" as TaskType,
      artifact: "CODE" as const,
    },
    {
      keywords: ["migrate", "move", "transfer", "convert", "transform"],
      name: "Migration",
      type: "code" as TaskType,
      artifact: "PATCH" as const,
    },
    {
      keywords: ["configure", "setup", "install", "initialize", "create environment"],
      name: "Setup",
      type: "creative" as TaskType,
      artifact: "CODE" as const,
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

/**
 * Extracts explicit and implied intent checklist items into a structured ledger.
 * Gates multi-turn execution against dropped requirements and prevents arbitrary actions.
 */
export function decomposeRequestIntoLedger(
  prompt: string,
  maxItems: number = 8
): IntentLedgerItem[] {
  if (!prompt || typeof prompt !== "string") return [];
  const text = prompt.trim();
  if (text.length < 5) return [];

  // Skip ledger creation for purely informational questions, explanations, or advisory inquiries
  // Questions starting with "how do i", "how can i", "how to", "why does", "what is" are advisory inquiries
  // unless they explicitly instruct direct execution (e.g. "and then fix", "please implement", "go ahead and create")
  const isAdvisoryInquiry =
    /^(?:how\s+(?:do|can|would|should)\s+i|how\s+to|why\s+(?:is|does|did|would)|what\s+(?:is|are|does)|can\s+you\s+explain|tell\s+me\s+about|explain\s+how)\b/i.test(
      text
    ) &&
    !/\b(?:and\s+(?:then\s+)?(?:fix|build|implement|create|update|apply)|please\s+(?:fix|implement|build|create|update)|go\s+ahead\s+and|apply\s+(?:the\s+)?fix)\b/i.test(
      text
    );
  if (isAdvisoryInquiry) return [];

  const items: IntentLedgerItem[] = [];

  // 1. Extract explicit candidate segments:
  // Check for numbered items (e.g. "1. fix API route", "2) add DB migration")
  const numberedMatches = Array.from(
    text.matchAll(/(?:^|\n|\s)(?:\d+[\.)]|[-*•])\s+([^\n]+)/g)
  ).map((m) => m[1].trim());

  let explicitSegments: string[] = [];
  if (numberedMatches.length >= 2) {
    explicitSegments = numberedMatches;
  } else {
    // Split by comma, "and", "then", or semicolon if clauses contain action verbs
    const actionVerbRegex =
      /\b(fix|add|create|implement|update|refactor|test|write|modify|migrate|build|setup|delete|remove)\b/i;
    const rawClauses = text
      .split(/(?:\r?\n|;|\band\s+then\b|\bthen\b|,\s*and\b|\band\b)/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 3 && actionVerbRegex.test(c));

    if (rawClauses.length >= 2) {
      explicitSegments = rawClauses;
    } else {
      // Single composite or standalone request
      explicitSegments = [text];
    }
  }

  // Deduplicate and cap explicit segments
  explicitSegments = Array.from(new Set(explicitSegments)).slice(0, maxItems);

  // Helper to detect layer from text
  const detectLayer = (str: string): IntentLayer => {
    const s = str.toLowerCase();
    if (/\b(test|spec|assert|coverage|verify|unit\s*test|integration\s*test)\b/i.test(s))
      return "test";
    if (/\b(migration|schema|table|db|database|sqlite|postgres|sql|prisma|model)\b/i.test(s))
      return "data";
    if (/\b(form|page|view|screen|button|css|frontend|modal|component|ui|input|dialog)\b/i.test(s))
      return "ui";
    if (/\b(route|endpoint|handler|controller|api|server|rest|webhook|middleware)\b/i.test(s))
      return "api";
    if (/\b(env|config|docker|package\.json|tsconfig|setting)\b/i.test(s)) return "config";
    if (/\b(doc|docs|readme|documentation|comment)\b/i.test(s)) return "docs";
    return "api";
  };

  // Helper to extract file references
  const extractFiles = (str: string): string[] => {
    const matches = str.match(
      /(?:src\/|[a-zA-Z0-9_\-\.\/]+\/)?([a-zA-Z0-9_\-]+\.(?:ts|tsx|js|jsx|json|sql|md|css|html|yml|yaml|env))/gi
    );
    return matches ? Array.from(new Set(matches)) : [];
  };

  // Helper to generate acceptance criteria
  const getAcceptance = (layer: IntentLayer, _desc?: string): string => {
    switch (layer) {
      case "test":
        return "Automated test suite validates target feature behavior and assertions";
      case "data":
        return "Database migration/schema is idempotent, syntactically valid, and preserved";
      case "ui":
        return "UI component renders required controls and displays state without runtime exceptions";
      case "api":
        return "Endpoint/service handles payload and validates response correctly";
      case "config":
        return "Configuration file is valid and loads successfully";
      case "docs":
        return "Documentation accurately reflects implementation details";
    }
  };

  // 2. Build explicit ledger items
  for (let i = 0; i < explicitSegments.length; i++) {
    if (items.length >= maxItems) break;
    const seg = explicitSegments[i];
    const layer = detectLayer(seg);
    const files = extractFiles(seg);
    const id = `I${items.length + 1}`;

    items.push({
      id,
      text: seg.replace(/^[-*•\d\.\)]+\s*/, "").trim(),
      kind: "explicit",
      layer,
      gap: "missing",
      targetFiles: files.length > 0 ? files : undefined,
      acceptance: getAcceptance(layer, seg),
      status: "open",
    });
  }

  // 3. Infer required-implied items (unspoken requirements)
  // E.g. If user modifies UI form or adds API route, they need tests and validation.
  const hasTestItem = items.some((it) => it.layer === "test");
  const hasUiItem = items.find((it) => it.layer === "ui");
  const hasApiItem = items.find((it) => it.layer === "api");
  const hasDataItem = items.find((it) => it.layer === "data");

  // If UI form added without API/backend mentioned, infer backend route/validation
  if (hasUiItem && !hasApiItem && items.length < maxItems) {
    items.push({
      id: `I${items.length + 1}`,
      parentId: hasUiItem.id,
      text: `Backend route and validation for ${hasUiItem.text.slice(0, 50)}`,
      kind: "required-implied",
      layer: "api",
      gap: "missing",
      acceptance: "Backend validates inputs and persists submitted data without error",
      status: "open",
    });
  }

  // If Data/Migration added without API model alignment, infer model update
  if (hasDataItem && !hasApiItem && items.length < maxItems) {
    items.push({
      id: `I${items.length + 1}`,
      parentId: hasDataItem.id,
      text: `Model and typing alignment for ${hasDataItem.text.slice(0, 50)}`,
      kind: "required-implied",
      layer: "api",
      gap: "missing",
      acceptance: "Domain models and types align with updated schema",
      status: "open",
    });
  }

  // If code modifications are requested (API, UI, Data) but no test item exists, infer automated test as optional
  // (Prevents over-expansion and unnecessary actions when the user did not ask for new tests)
  if (!hasTestItem && (hasApiItem || hasUiItem || hasDataItem) && items.length < maxItems) {
    const parent = hasApiItem || hasUiItem || hasDataItem;
    items.push({
      id: `I${items.length + 1}`,
      parentId: parent?.id,
      text: `Unit/integration tests verifying ${parent ? parent.text.slice(0, 50) : "implementation"}`,
      kind: "optional",
      layer: "test",
      gap: "missing",
      acceptance: "Automated test suite executes and passes with zero regressions",
      status: "open",
    });
  }

  return items;
}

export type SessionLifecycleAction = "continuation" | "amendment" | "new_task";

export interface LifecycleResolution {
  action: SessionLifecycleAction;
  contract: GuidanceContract;
  directive?: string;
}

/**
 * Evaluates follow-up user messages within an active session against the existing Intent Ledger.
 * Disambiguates continuation (resuming in-flight work), amendment (modifying requirements),
 * and new tasks (initiating fresh objectives with archival of prior state).
 */
export function resolveSessionLifecycle(
  existingContract: GuidanceContract,
  newUserPrompt: string,
  maxItems: number = 8
): LifecycleResolution {
  const text = newUserPrompt.trim();
  const existingIntents = existingContract.intents || [];
  const allResolved =
    existingIntents.length > 0 &&
    existingIntents.every(
      (it) => it.status === "done" || it.status === "done_unverified" || it.status === "skipped"
    );

  // 1. Continuation: resuming unfulfilled work
  const isContinuation =
    /^(?:continue|proceed|keep\s+going|resume|finish(?:\s+the\s+rest|\s+up)?|go\s+ahead|what(?:'s|\s+is)\s+left)\b/i.test(
      text
    ) ||
    (/\b(?:continue|proceed|keep\s+going)\b/i.test(text) && text.length < 50);

  if (isContinuation && !allResolved) {
    for (const item of existingIntents) {
      if (item.status === "blocked") {
        item.status = "open";
        item.evidence = "Re-opened by user continuation directive";
      }
    }
    existingContract.consecutiveNoChangeReprompts = 0;
    return {
      action: "continuation",
      contract: existingContract,
      directive:
        "[SPB Continuation Directive: The user instructed you to continue. " +
        "Focus strictly on fulfilling the remaining open checklist items.]",
    };
  }

  // 2. Amendment: modifying in-flight specifications
  const isAmendment =
    /\b(?:actually|instead(?:\s+of)?|don't\s+do|skip|cancel|nevermind|also\s+add|one\s+more\s+thing)\b/i.test(
      text
    );

  if (isAmendment && !allResolved) {
    const skipMatch = text.match(
      /\b(?:skip|cancel|don't\s+(?:add|do|build|create))\s+([a-zA-Z0-9_\-]+(?:\s+[a-zA-Z0-9_\-]+){0,3}?)(?:\s+(?:and|also|instead)|,|\.|$)/i
    );
    if (skipMatch) {
      const targetPhrase = skipMatch[1].toLowerCase().trim();
      for (const item of existingIntents) {
        if (item.text.toLowerCase().includes(targetPhrase) || item.layer === targetPhrase) {
          item.status = "skipped";
          item.evidence = `Cancelled by user amendment: "${text.slice(0, 50)}"`;
        }
      }
    }

    if (/\b(?:also\s+add|one\s+more\s+thing|and\s+add)\b/i.test(text)) {
      const newItems = decomposeRequestIntoLedger(text, maxItems);
      for (const ni of newItems) {
        if (existingContract.intents && existingContract.intents.length < maxItems) {
          ni.id = `I${existingContract.intents.length + 1}`;
          existingContract.intents.push(ni);
        }
      }
    }

    existingContract.consecutiveNoChangeReprompts = 0;
    return {
      action: "amendment",
      contract: existingContract,
      directive:
        "[SPB Amendment Directive: The user modified task specifications. " +
        "The Intent Ledger has been updated with these changes.]",
    };
  }

  // If existing intents are incomplete, check if the new prompt introduces substantive new action directives
  if (!allResolved && existingIntents.length > 0 && text.length >= 10) {
    const isFollowupAction =
      /\b(?:also|and|now|please|can\s+you|fix|add|update|apply|research|investigate|check|test|diagnos|refactor|build)\b/i.test(
        text
      ) &&
      !/^(?:ok|yes|proceed|continue|carry\s+on|go\s+ahead|sure|fine|yep|done|next)\b/i.test(text);

    if (isFollowupAction) {
      const newCandidateItems = decomposeRequestIntoLedger(text, maxItems);
      if (newCandidateItems.length > 0) {
        for (const ni of newCandidateItems) {
          const isDuplicate = existingContract.intents?.some(
            (ex) => ex.text.toLowerCase().trim() === ni.text.toLowerCase().trim()
          );
          if (
            !isDuplicate &&
            existingContract.intents &&
            existingContract.intents.length < maxItems
          ) {
            ni.id = `I${existingContract.intents.length + 1}`;
            existingContract.intents.push(ni);
          }
        }
        existingContract.consecutiveNoChangeReprompts = 0;
        return {
          action: "amendment",
          contract: existingContract,
          directive:
            "[SPB Amendment Directive: Additional goals identified from user prompt. " +
            "The Intent Ledger has been enriched with the new requirements.]",
        };
      }
    }
  }

  // 3. New Task: prior work completed, or user initiates brand new instructions
  if (allResolved || (existingIntents.length === 0 && text.length > 0)) {
    const archived = Array.isArray(existingContract.archivedContracts)
      ? (existingContract.archivedContracts as Array<Record<string, unknown>>)
      : [];
    if (existingIntents.length > 0) {
      archived.push({
        taskSpecification: existingContract.taskSpecification,
        intents: existingIntents,
        completedAt: Date.now(),
      });
    }

    const newContract: GuidanceContract = {
      ...existingContract,
      taskSpecification: text,
      intents: decomposeRequestIntoLedger(text, maxItems),
      strictCompletion: existingContract.strictCompletion,
      archivedContracts: archived,
      consecutiveNoChangeReprompts: 0,
      createdAt: Date.now(),
    };

    return {
      action: "new_task",
      contract: newContract,
    };
  }

  return { action: "continuation", contract: existingContract };
}

/**
 * Apex Tier Intent Expansion with Prompt-Anchor Caching.
 * Performs deep full-lifecycle cross-layer decomposition, identifying unspoken requirements,
 * implied validation schemas, edge cases, and scope fences.
 * Caches expansions in durable SQLite storage keyed by prompt anchor hash.
 */
export function expandIntentLedgerApex(
  prompt: string,
  promptAnchorHash: string,
  maxItems: number = 8
): IntentLedgerItem[] {
  // 1. Check prompt-anchor cache for instant retrieval
  try {
    const cached = getLearnedOptimization(promptAnchorHash);
    if (cached?.enhancementTemplate) {
      const parsed = JSON.parse(cached.enhancementTemplate);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as IntentLedgerItem[];
      }
    }
  } catch {
    // Non-blocking cache retrieval fallback
  }

  // 2. Base heuristic decomposition
  const items = decomposeRequestIntoLedger(prompt, maxItems);
  if (items.length === 0) return [];

  // 3. Apex Deep Full-Lifecycle Expansion (Unspoken intent discovery)
  const explicitItems = [...items];

  for (const expItem of explicitItems) {
    if (items.length >= maxItems) break;

    // A. Form / UI Component implies client input validation and API contract
    if (expItem.layer === "ui" && expItem.kind === "explicit") {
      const hasValidation = items.some((it) => it.parentId === expItem.id && it.layer === "ui");
      if (!hasValidation && items.length < maxItems) {
        items.push({
          id: `I${items.length + 1}`,
          parentId: expItem.id,
          text: `Client input validation and error feedback states for ${expItem.text.slice(0, 40)}`,
          kind: "required-implied",
          layer: "ui",
          gap: "missing",
          acceptance:
            "Form handles empty, invalid, and boundary inputs with visible error feedback",
          status: "open",
        });
      }
    }

    // B. API Route implies request schema validation and HTTP status codes
    if (expItem.layer === "api" && expItem.kind === "explicit") {
      const hasValidation = items.some(
        (it) => it.parentId === expItem.id && it.text.toLowerCase().includes("validation")
      );
      if (!hasValidation && items.length < maxItems) {
        items.push({
          id: `I${items.length + 1}`,
          parentId: expItem.id,
          text: `Request body/query schema validation and 4xx/5xx status handling for ${expItem.text.slice(0, 40)}`,
          kind: "required-implied",
          layer: "api",
          gap: "missing",
          acceptance:
            "Endpoint validates payload via Zod/schema and returns 400 on malformed input",
          status: "open",
        });
      }
    }

    // C. Data migration implies idempotent rollback and entity model typing
    if (expItem.layer === "data" && expItem.kind === "explicit") {
      const hasModel = items.some((it) => it.parentId === expItem.id);
      if (!hasModel && items.length < maxItems) {
        items.push({
          id: `I${items.length + 1}`,
          parentId: expItem.id,
          text: `Idempotent migration schema and TypeScript entity typing for ${expItem.text.slice(0, 40)}`,
          kind: "required-implied",
          layer: "data",
          gap: "missing",
          acceptance: "Database migration executes idempotently without table corruption",
          status: "open",
        });
      }
    }
  }

  // 4. Save to persistent SQLite cache
  try {
    saveLearnedOptimization({
      patternHash: promptAnchorHash,
      tier: "tier_1_apex",
      taskPhase: "ARCHITECTURAL_PLANNING",
      optimizationStrategy: "apex_intent_ledger",
      enhancementTemplate: JSON.stringify(items),
      successCount: 1,
      failureCount: 0,
      avgSatisfactionScore: 1.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch {
    // Non-blocking telemetry
  }

  return items;
}
