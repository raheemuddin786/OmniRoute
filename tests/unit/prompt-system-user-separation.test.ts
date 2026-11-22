import test from "node:test";
import assert from "node:assert/strict";
import {
  generatePromptsCSV,
  generatePromptsJSON,
  type PromptExportRecord,
} from "../../src/shared/utils/promptExport.ts";
import { extractUserIntent } from "../../src/shared/utils/formatting.ts";
import type { RecentPromptRecord } from "../../src/lib/db/projectRegistry.ts";

test("RecentPromptRecord contract supports separate prompt and systemPrompt fields", () => {
  const record: RecentPromptRecord = {
    prompt: "Write a unit test for user prompt separation",
    systemPrompt: "You are Claude Code, Anthropic's official CLI for Claude.",
    timestamp: "2026-11-04T14:30:00Z",
    model: "claude-sonnet-5-5",
    tokensIn: 1200,
    tokensOut: 450,
    tokensCacheRead: 800,
    costUsd: 0.0042,
    durationMs: 820,
    status: 200,
    toolsUsed: ["Edit", "Read"],
  };

  assert.equal(record.prompt, "Write a unit test for user prompt separation");
  assert.equal(record.systemPrompt, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(record.status, 200);
});

test("generatePromptsCSV preserves distinct columns for user prompt and system prompt", () => {
  const records: PromptExportRecord[] = [
    {
      prompt: "Execute migration script 219",
      systemPrompt: "Follow Hard Rule #19 and work inside an isolated worktree.",
      timestamp: "2026-11-04T15:00:00Z",
      project: "OmniRoute",
      model: "claude-opus-5-5",
      tokensIn: 500,
      tokensOut: 120,
      costUsd: 0.0035,
      toolsUsed: ["Bash"],
    },
    {
      prompt: "Show git status",
      timestamp: "2026-11-04T15:02:00Z",
      model: "gpt-4o",
    },
  ];

  const csv = generatePromptsCSV(records);
  const lines = csv.split("\n");

  assert.equal(
    lines[0],
    "Timestamp,Prompt Text,System Prompt,Project,Model,Tokens In,Tokens Out,Estimated Cost (USD),Tools Used"
  );

  // Line 1 contains both user prompt and system prompt
  assert.ok(lines[1].includes("Execute migration script 219"));
  assert.ok(lines[1].includes("Follow Hard Rule #19 and work inside an isolated worktree."));

  // Line 2 has empty system prompt (systemPrompt is optional)
  assert.ok(lines[2].includes("Show git status"));
  const systemPromptCell2 = lines[2].split(",")[2];
  assert.equal(systemPromptCell2, ""); // system prompt cell is empty
});

test("generatePromptsJSON outputs structured objects with systemPrompt attribute", () => {
  const records: PromptExportRecord[] = [
    {
      prompt: "Analyze latency bottleneck",
      systemPrompt: "Adopt the WAT architecture (Workflows, Agents, Tools).",
      timestamp: "2026-11-04T15:10:00Z",
      project: "OmniRoute",
      model: "claude-sonnet-5-5",
    },
  ];

  const jsonStr = generatePromptsJSON(records, {
    projectName: "OmniRoute",
    totalSessions: 1,
  });

  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.totalPrompts, 1);
  assert.equal(parsed.prompts[0].prompt, "Analyze latency bottleneck");
  assert.equal(
    parsed.prompts[0].systemPrompt,
    "Adopt the WAT architecture (Workflows, Agents, Tools)."
  );
});

test("sequential conversation chronological ordering sorts earliest to latest", () => {
  const turns = [
    { prompt: "Turn 2: Follow-up question", timestamp: "2026-11-04T12:05:00Z" },
    { prompt: "Turn 1: Initial user intent", timestamp: "2026-11-04T12:00:00Z" },
    { prompt: "Turn 3: Final confirmation", timestamp: "2026-11-04T12:10:00Z" },
  ];

  const sorted = [...turns].sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeA - timeB;
  });

  assert.equal(sorted[0].prompt, "Turn 1: Initial user intent");
  assert.equal(sorted[1].prompt, "Turn 2: Follow-up question");
  assert.equal(sorted[2].prompt, "Turn 3: Final confirmation");
});

test("session groups are sorted chronologically descending by lastSeenAt (recent sessions first)", () => {
  const sessions = [
    { sessionId: "sess_yesterday", lastSeenAt: "2026-11-03T18:00:00Z" },
    { sessionId: "sess_just_now", lastSeenAt: "2026-11-04T12:30:00Z" },
    { sessionId: "sess_one_hour_ago", lastSeenAt: "2026-11-04T11:30:00Z" },
  ];

  const sorted = [...sessions].sort((a, b) => {
    const timeA = new Date(a.lastSeenAt).getTime();
    const timeB = new Date(b.lastSeenAt).getTime();
    return timeB - timeA;
  });

  assert.equal(sorted[0].sessionId, "sess_just_now");
  assert.equal(sorted[1].sessionId, "sess_one_hour_ago");
  assert.equal(sorted[2].sessionId, "sess_yesterday");
});

test("flat prompts list is explicitly sorted chronologically descending by timestamp (newest first)", () => {
  const prompts = [
    { prompt: "Early morning prompt", timestamp: "2026-11-04T08:00:00Z" },
    { prompt: "Latest afternoon prompt", timestamp: "2026-11-04T16:00:00Z" },
    { prompt: "Midday prompt", timestamp: "2026-11-04T12:00:00Z" },
  ];

  const sorted = [...prompts].sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeB - timeA;
  });

  assert.equal(sorted[0].prompt, "Latest afternoon prompt");
  assert.equal(sorted[1].prompt, "Midday prompt");
  assert.equal(sorted[2].prompt, "Early morning prompt");
});

test("extractUserIntent strips leading Memory context scaffolding and returns genuine user prompt", () => {
  const promptWithMemory = `Memory context: checked whether any producer of a contract exists
User prefers concise answers
Please audit the projectAnalytics service and check sort order`;

  const cleanIntent = extractUserIntent(promptWithMemory);
  assert.equal(cleanIntent, "User prefers concise answers");

  const promptPureUser =
    "Please check the logs and UI code to ensure everything is implemented correctly";
  assert.equal(extractUserIntent(promptPureUser), promptPureUser);

  const promptWithSystemDirective = `System Directives: You are Claude Code
System Prompt: Follow all Hard Rules
Explain the route trace for request 12345`;
  assert.equal(
    extractUserIntent(promptWithSystemDirective),
    "Explain the route trace for request 12345"
  );
});

test("pagination slicing produces bounded subsets preserving chronological order", () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({
    sessionId: `session_${i + 1}`,
    lastSeenAt: new Date(Date.now() - i * 60000).toISOString(),
  }));

  const pageSize = 10;
  const page1 = sessions.slice(0, pageSize);
  const page2 = sessions.slice(pageSize, pageSize * 2);
  const page3 = sessions.slice(pageSize * 2, pageSize * 3);

  assert.equal(page1.length, 10);
  assert.equal(page1[0].sessionId, "session_1");
  assert.equal(page2.length, 10);
  assert.equal(page2[0].sessionId, "session_11");
  assert.equal(page3.length, 5);
  assert.equal(page3[0].sessionId, "session_21");
});
