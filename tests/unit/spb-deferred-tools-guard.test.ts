import { describe, it } from "node:test";
import assert from "node:assert";
import {
  extractContextAnchors,
  enhanceInboundPrompt,
} from "../../open-sse/services/spb/inboundIntelligence.ts";

describe("SPB Deferred Tools Pre-Flight Directive", () => {
  it("detects deferred tools notice in system messages", () => {
    const messages = [
      {
        role: "system",
        content:
          'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nWebSearch\nWebFetch',
      },
      {
        role: "user",
        content: "Please search for the latest medical guidelines.",
      },
    ];

    const anchors = extractContextAnchors(messages);
    assert.strictEqual(anchors.hasDeferredToolsNotice, true);

    const enhancement = enhanceInboundPrompt(
      "Please search for the latest medical guidelines.",
      "tier_1_apex",
      "ARCHITECTURAL_PLANNING",
      messages
    );

    assert.ok(enhancement.enhancedPrompt.includes("[Deferred Tools Protocol:"));
    assert.ok(enhancement.enhancedPrompt.includes("ToolSearch with query 'select:<ToolName>'"));
    assert.ok(
      enhancement.appliedOptimizations.includes("Deferred Tools Protocol Pre-Flight Directive")
    );
  });

  it("omits deferred tools notice when no deferred tools are announced in system prompt", () => {
    const messages = [
      {
        role: "system",
        content: "You are an assistant.",
      },
      {
        role: "user",
        content: "Create a new function.",
      },
    ];

    const anchors = extractContextAnchors(messages);
    assert.strictEqual(anchors.hasDeferredToolsNotice, false);

    const enhancement = enhanceInboundPrompt(
      "Create a new function.",
      "tier_1_apex",
      "ARCHITECTURAL_PLANNING",
      messages
    );

    assert.strictEqual(enhancement.enhancedPrompt.includes("[Deferred Tools Protocol:"), false);
    assert.strictEqual(
      enhancement.appliedOptimizations.includes("Deferred Tools Protocol Pre-Flight Directive"),
      false
    );
  });
});
