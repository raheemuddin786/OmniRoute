import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNoCompactionRequested } from "../../open-sse/handlers/chatCore/headers.ts";
import { assembleStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/streamingResponseHeaders.ts";
import { buildNonStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/nonStreamingResponseHeaders.ts";

describe("context compaction observability and policy headers", () => {
  it("recognizes no-compaction opt-out headers case-insensitively", () => {
    assert.equal(isNoCompactionRequested({ "x-omniroute-no-compaction": "true" }), true);
    assert.equal(isNoCompactionRequested({ "X-OmniRoute-No-Compaction": "1" }), true);
    assert.equal(isNoCompactionRequested({ "x-no-compression": "yes" }), true);
    assert.equal(isNoCompactionRequested({ "X-No-Compression": "True" }), true);
    assert.equal(isNoCompactionRequested({ "x-context-fail-loud": "1" }), true);
    assert.equal(isNoCompactionRequested({ "x-omniroute-no-compaction": "false" }), false);
    assert.equal(isNoCompactionRequested(null), false);
    assert.equal(isNoCompactionRequested({}), false);
  });

  it("attaches compaction metadata and tools-truncated headers to streaming responses", () => {
    const providerHeaders = new Headers();
    const headers = assembleStreamingResponseHeaders({
      providerHeaders,
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      pendingRequestId: "req-123",
      compactionMeta: {
        compressed: true,
        type: "proactive",
        tokensOriginal: 160000,
        tokensFinal: 120000,
        layers: ["trim_tools", "purify_history"],
      },
      toolsTruncated: 4,
    });

    assert.equal(headers["X-OmniRoute-Context-Compressed"], "true");
    assert.equal(headers["X-OmniRoute-Compaction-Type"], "proactive");
    assert.equal(headers["X-OmniRoute-Tokens-Original"], "160000");
    assert.equal(headers["X-OmniRoute-Tokens-Final"], "120000");
    assert.equal(headers["X-OmniRoute-Compaction-Layers"], "trim_tools,purify_history");
    assert.equal(headers["X-OmniRoute-Tools-Truncated"], "4");
  });

  it("attaches compaction metadata and tools-truncated headers to non-streaming responses", () => {
    const headers = buildNonStreamingResponseHeaders({
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      startTime: Date.now() - 50,
      responseUsage: { prompt_tokens: 100, completion_tokens: 20 },
      estimatedCost: 0.001,
      requestId: "req-456",
      compactionMeta: {
        compressed: true,
        type: "last-resort",
        tokensOriginal: 198000,
        tokensFinal: 140000,
        layers: ["purify_history"],
      },
      toolsTruncated: 2,
    });

    assert.equal(headers["X-OmniRoute-Context-Compressed"], "true");
    assert.equal(headers["X-OmniRoute-Compaction-Type"], "last-resort");
    assert.equal(headers["X-OmniRoute-Tokens-Original"], "198000");
    assert.equal(headers["X-OmniRoute-Tokens-Final"], "140000");
    assert.equal(headers["X-OmniRoute-Compaction-Layers"], "purify_history");
    assert.equal(headers["X-OmniRoute-Tools-Truncated"], "2");
  });
});
