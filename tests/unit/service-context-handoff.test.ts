import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/services/contextHandoff.ts");

describe("contextHandoff helpers", () => {
  describe("selectMessagesForSummary", () => {
    it("returns messages within limit", () => {
      const messages = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      const result = mod.selectMessagesForSummary(messages, 10);
      assert.equal(result.length, 3);
    });

    it("preserves system messages and limits non-system", () => {
      const messages = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "msg1" },
        { role: "assistant", content: "reply1" },
        { role: "user", content: "msg2" },
        { role: "assistant", content: "reply2" },
      ];
      const result = mod.selectMessagesForSummary(messages, 2);
      // Should keep system + last 2 non-system
      assert.equal(result.length, 3);
      assert.equal(result[0].role, "system");
    });

    it("filters out null/invalid messages", () => {
      const messages = [null, { role: "user", content: "valid" }, undefined, 42];
      const result = mod.selectMessagesForSummary(messages as unknown as mod.MessageLike[], 10);
      assert.equal(result.length, 1);
    });

    it("returns empty array for empty input", () => {
      const result = mod.selectMessagesForSummary([], 10);
      assert.equal(result.length, 0);
    });
  });

  describe("parseHandoffJSON", () => {
    it("parses valid handoff JSON", () => {
      const content = JSON.stringify({
        summary: "Working on auth module",
        keyDecisions: ["Use JWT", "Short expiry"],
        taskProgress: "50% complete",
        activeEntities: ["auth.ts", "middleware.ts"],
      });
      const result = mod.parseHandoffJSON(content);
      assert.notEqual(result, null);
      assert.equal(result!.summary, "Working on auth module");
      assert.equal(result!.keyDecisions.length, 2);
      assert.equal(result!.taskProgress, "50% complete");
    });

    it("returns null for empty summary", () => {
      const content = JSON.stringify({ summary: "", keyDecisions: [] });
      const result = mod.parseHandoffJSON(content);
      assert.equal(result, null);
    });

    it("returns null for invalid JSON", () => {
      const result = mod.parseHandoffJSON("not json at all");
      assert.equal(result, null);
    });

    it("truncates long summary", () => {
      const longSummary = "x".repeat(5000);
      const content = JSON.stringify({ summary: longSummary });
      const result = mod.parseHandoffJSON(content);
      assert.notEqual(result, null);
      assert.ok(result!.summary.length <= 2000);
    });

    it("normalizes keyDecisions array", () => {
      const content = JSON.stringify({
        summary: "Test",
        keyDecisions: ["valid", "", 123, null, "also valid"],
      });
      const result = mod.parseHandoffJSON(content);
      assert.notEqual(result, null);
      assert.equal(result!.keyDecisions.length, 2);
    });

    it("parses conversational text containing embedded markdown json block", () => {
      const content = `We need to produce JSON with summary, keyDecisions, taskProgress, activeEntities.

We need to summarize conversation: It is about a lead generator agent...
\`\`\`json
{
  "summary": "Deployment of the marriage-portfolio worker succeeded.",
  "keyDecisions": ["Separate forms"],
  "taskProgress": "Form fix completed",
  "activeEntities": ["src/views/biodata_view.ts"]
}
\`\`\`
Extra text after code block`;
      const result = mod.parseHandoffJSON(content);
      assert.notEqual(result, null);
      assert.equal(result!.summary, "Deployment of the marriage-portfolio worker succeeded.");
      assert.deepEqual(result!.keyDecisions, ["Separate forms"]);
      assert.equal(result!.taskProgress, "Form fix completed");
    });

    it("extracts and repairs truncated JSON cut off at max_tokens", () => {
      const truncated =
        '{\n  "summary": "The marriage-portfolio project was audited for mobile responsiveness, a form';
      const result = mod.parseHandoffJSON(truncated);
      assert.notEqual(result, null);
      assert.equal(
        result!.summary,
        "The marriage-portfolio project was audited for mobile responsiveness, a form"
      );
    });

    it("strips <think> tags before extracting JSON", () => {
      const content = `<think>
Analyzing the conversation history and drafting key decisions...
</think>
\`\`\`json
{
  "summary": "Clean summary after think tags",
  "keyDecisions": ["Refactored auth"],
  "taskProgress": "Testing done",
  "activeEntities": ["auth.ts"]
}
\`\`\``;
      const result = mod.parseHandoffJSON(content);
      assert.notEqual(result, null);
      assert.equal(result!.summary, "Clean summary after think tags");
      assert.deepEqual(result!.keyDecisions, ["Refactored auth"]);
    });
  });

  describe("constants", () => {
    it("HANDOFF_WARNING_THRESHOLD is 0.85", () => {
      assert.equal(mod.HANDOFF_WARNING_THRESHOLD, 0.85);
    });

    it("HANDOFF_EXHAUSTION_THRESHOLD is 0.95", () => {
      assert.equal(mod.HANDOFF_EXHAUSTION_THRESHOLD, 0.95);
    });
  });
});
