import test from "node:test";
import assert from "node:assert/strict";
import {
  generatePromptsCSV,
  generatePromptsJSON,
  type PromptExportRecord,
} from "../../src/shared/utils/promptExport.ts";

test("generatePromptsCSV outputs valid header and escaped CSV rows", () => {
  const records: PromptExportRecord[] = [
    {
      prompt: 'Hello, "world"!\nMultiline prompt',
      timestamp: "2026-11-04T12:00:00Z",
      project: "Project Alpha",
      model: "claude-sonnet-5-5",
      costUsd: 0.001234,
      tokensIn: 100,
      tokensOut: 250,
      toolsUsed: ["memory_search", "grep_tool"],
    },
    {
      prompt: "Single line simple query",
      timestamp: "2026-11-04T12:05:00Z",
      tokensIn: 50,
      tokensOut: 80,
    },
  ];

  const csv = generatePromptsCSV(records);
  assert.ok(
    csv.includes(
      "Timestamp,Prompt Text,Project,Model,Tokens In,Tokens Out,Estimated Cost (USD),Tools Used"
    )
  );
  assert.ok(csv.includes('"Hello, ""world""!\nMultiline prompt"'));
  assert.ok(csv.includes("Project Alpha"));
  assert.ok(csv.includes("claude-sonnet-5-5"));
  assert.ok(csv.includes("memory_search; grep_tool"));
  assert.ok(csv.includes("Single line simple query"));
});

test("generatePromptsJSON generates valid JSON structure with metadata", () => {
  const records: PromptExportRecord[] = [
    {
      prompt: "Explain quantum computing in one sentence",
      timestamp: "2026-11-04T12:10:00Z",
      project: "OmniRoute",
      model: "gpt-4o",
      costUsd: 0.00045,
      tokensIn: 15,
      tokensOut: 30,
    },
  ];

  const jsonStr = generatePromptsJSON(records, {
    projectName: "OmniRoute",
    totalSessions: 1,
  });

  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.totalPrompts, 1);
  assert.equal(parsed.metadata.projectName, "OmniRoute");
  assert.equal(parsed.metadata.totalSessions, 1);
  assert.equal(parsed.prompts.length, 1);
  assert.equal(parsed.prompts[0].prompt, "Explain quantum computing in one sentence");
  assert.equal(parsed.prompts[0].model, "gpt-4o");
});
