import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelAlias } from "../../open-sse/services/modelDeprecation.ts";
import { DEFAULT_MODEL_ALIAS_SEED } from "../../src/lib/modelAliasSeed.ts";
import {
  normalizeClaudeWebModel,
  transformToClaude,
  DEFAULT_CLAUDE_MODEL,
} from "../../open-sse/executors/claude-web/payload.ts";
import { parseDetailedRetryHintFromJsonBody } from "../../open-sse/services/retryAfterJson.ts";
import type { ResolvedComboTarget, ComboLogger } from "../../open-sse/services/combo/types.ts";
import type { ApplyComboTargetExhaustionOptions } from "../../open-sse/services/combo/targetExhaustion.ts";

describe("Claude 3.5 Sonnet Deprecation & Routing Aliases", () => {
  it("resolves claude-3-5-sonnet-20241022 to active catalog replacement claude-sonnet-4-6", () => {
    assert.equal(resolveModelAlias("claude-3-5-sonnet-20241022"), "claude-sonnet-4-6");
  });

  it("resolves claude-3-5-sonnet-20240620 to active catalog replacement claude-sonnet-4-6", () => {
    assert.equal(resolveModelAlias("claude-3-5-sonnet-20240620"), "claude-sonnet-4-6");
  });

  it("resolves bare claude-3-5-sonnet to claude-sonnet-4-6", () => {
    assert.equal(resolveModelAlias("claude-3-5-sonnet"), "claude-sonnet-4-6");
  });

  it("resolves claude-3-7-sonnet and snapshot to claude-sonnet-4-6", () => {
    assert.equal(resolveModelAlias("claude-3-7-sonnet"), "claude-sonnet-4-6");
    assert.equal(resolveModelAlias("claude-3-7-sonnet-20250219"), "claude-sonnet-4-6");
  });

  it("resolves claude-3-5-haiku-20241022 to claude-haiku-4-5-20251001", () => {
    assert.equal(resolveModelAlias("claude-3-5-haiku-20241022"), "claude-haiku-4-5-20251001");
  });

  it("seeds snapshot aliases in DEFAULT_MODEL_ALIAS_SEED", () => {
    assert.equal(DEFAULT_MODEL_ALIAS_SEED["claude-3-5-sonnet-20241022"], "agy/claude-sonnet-4-6");
    assert.equal(DEFAULT_MODEL_ALIAS_SEED["claude-3-5-sonnet-20240620"], "agy/claude-sonnet-4-6");
    assert.equal(DEFAULT_MODEL_ALIAS_SEED["claude-3-7-sonnet-20250219"], "agy/claude-sonnet-4-6");
  });
});

describe("Claude Web Model Normalization & Payload Transformation", () => {
  it("normalizes legacy and API format Sonnet names to claude-sonnet-4-6", () => {
    assert.equal(normalizeClaudeWebModel("claude-3-5-sonnet-20241022"), "claude-sonnet-4-6");
    assert.equal(normalizeClaudeWebModel("claude-3-5-sonnet"), "claude-sonnet-4-6");
    assert.equal(normalizeClaudeWebModel("claude-3-7-sonnet-20250219"), "claude-sonnet-4-6");
    assert.equal(
      normalizeClaudeWebModel("claude-web/claude-3-5-sonnet-20241022"),
      "claude-sonnet-4-6"
    );
  });

  it("preserves exact native web catalog models", () => {
    assert.equal(normalizeClaudeWebModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
    assert.equal(normalizeClaudeWebModel("claude-sonnet-5"), "claude-sonnet-5");
    assert.equal(normalizeClaudeWebModel("claude-sonnet-5-5"), "claude-sonnet-5-5");
    assert.equal(normalizeClaudeWebModel("claude-opus-5"), "claude-opus-5");
    assert.equal(normalizeClaudeWebModel("claude-opus-4-8"), "claude-opus-4-8");
    assert.equal(normalizeClaudeWebModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
  });

  it("normalizes legacy Opus and Haiku models", () => {
    assert.equal(normalizeClaudeWebModel("claude-3-opus-20240229"), "claude-opus-4-8");
    assert.equal(normalizeClaudeWebModel("claude-3-haiku-20240307"), "claude-haiku-4-5-20251001");
  });

  it("falls back safely to DEFAULT_CLAUDE_MODEL for null, empty or unknown models", () => {
    assert.equal(normalizeClaudeWebModel(null), DEFAULT_CLAUDE_MODEL);
    assert.equal(normalizeClaudeWebModel(""), DEFAULT_CLAUDE_MODEL);
    assert.equal(normalizeClaudeWebModel("unknown-model"), DEFAULT_CLAUDE_MODEL);
  });

  it("transforms Claude Web payload with normalized model", () => {
    const payload = transformToClaude(
      {
        messages: [{ role: "user", content: "Hello from Claude Desktop" }],
      },
      "claude-3-5-sonnet-20241022"
    );

    assert.equal(payload.model, "claude-sonnet-4-6");
    assert.equal(payload.create_conversation_params?.model, "claude-sonnet-4-6");
    assert.equal(payload.prompt, "Hello from Claude Desktop");
  });

  it("normalizes effort-suffixed models and extracts reasoning effort", () => {
    assert.equal(normalizeClaudeWebModel("claude-fable-5-1-low"), "claude-fable-5-1");
    assert.equal(normalizeClaudeWebModel("claude-fable-5-1-high"), "claude-fable-5-1");
    assert.equal(normalizeClaudeWebModel("claude-sonnet-5-low"), "claude-sonnet-5");

    const payload = transformToClaude(
      {
        messages: [{ role: "user", content: "Thinking test" }],
      },
      "claude-fable-5-1-low"
    );
    assert.equal(payload.model, "claude-fable-5-1");
    assert.equal(payload.effort, "low");
    assert.equal(payload.thinking_mode, "extended");
  });
});

describe("Claude Web Multiplexed Failure Scope & Exhaustion", () => {
  it("treats claude-web as having per-model failure scope", async () => {
    const { hasPerModelFailureScope } =
      await import("../../open-sse/services/accountFallback/perModelFailureScope.ts");
    assert.equal(hasPerModelFailureScope("claude-web"), true);
    assert.equal(hasPerModelFailureScope("cw"), true);
    assert.equal(hasPerModelFailureScope("claude"), true);
  });

  it("does not exhaust provider connection on 403 when perModelFailureScope applies", async () => {
    const { applyComboTargetExhaustion } =
      await import("../../open-sse/services/combo/targetExhaustion.ts");
    const sets = {
      exhaustedProviders: new Set<string>(),
      exhaustedConnections: new Set<string>(),
      transientRateLimitedProviders: new Set<string>(),
      circuitOpenProviders: new Set<string>(),
    };

    const target: ResolvedComboTarget = {
      kind: "model",
      stepId: "step-1",
      executionKey: "exec-1",
      modelStr: "claude-web/claude-fable-5-1-low",
      provider: "claude-web",
      authType: null,
      providerId: null,
      connectionId: "conn-123",
      allowedConnectionIds: null,
      weight: 1,
      label: null,
      prompt: null,
      failoverBeforeRetry: undefined,
      fallbackOnlyOnQuotaExhaustion: false,
      trafficType: "production",
    };

    const opts: ApplyComboTargetExhaustionOptions = {
      result: { status: 403, headers: null },
      fallbackResult: { cooldownMs: 30000, reason: "auth_error" },
      errorText: "Claude Web API error (403)",
      rawModel: "claude-web/claude-fable-5-1-low",
      isTokenLimitBreach: false,
      allAccountsRateLimited: false,
      requestScopedFailure: false,
      sets,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tag: "COMBO",
      exhaustedLogLevel: "info",
    };

    const result = applyComboTargetExhaustion(target, opts);

    assert.equal(result.providerExhausted, false);
    assert.equal(sets.exhaustedConnections.has("claude-web:conn-123"), false);
  });
});

describe("Claude Web 429 Retry-After Hint Extraction", () => {
  it("extracts future reset timestamp from JSON error bodies", () => {
    const futureEpochSeconds = Math.floor(Date.now() / 1000) + 120;
    const errorBody = JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "You have exceeded your usage limit",
        resets_at: futureEpochSeconds,
      },
    });

    const hint = parseDetailedRetryHintFromJsonBody(errorBody, 3600 * 1000);
    assert.ok(hint);
    assert.equal(hint.provenance, "body");
    // Should be around ~120s in ms
    assert.ok(hint.retryAfterMs >= 115000 && hint.retryAfterMs <= 125000);
  });
});

describe("Claude Web Combo Tool Calling Capability & Filtering", () => {
  it("resolves toolCalling: true for claude-web Sonnet models in registry", async () => {
    const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");

    const sonnet5Caps = getResolvedModelCapabilities({
      provider: "claude-web",
      model: "claude-web/claude-sonnet-5",
    });
    assert.equal(sonnet5Caps.toolCalling, true);
    assert.equal(sonnet5Caps.supportsTools, true);

    const sonnet46Caps = getResolvedModelCapabilities({
      provider: "claude-web",
      model: "claude-web/claude-sonnet-4-6",
    });
    assert.equal(sonnet46Caps.toolCalling, true);
    assert.equal(sonnet46Caps.supportsTools, true);
  });

  it("keeps claude-web Sonnet targets eligible when request carries tools", async () => {
    const { filterTargetsByRequestCompatibility, describeCapabilityFilterExhaustion } =
      await import("../../open-sse/services/combo/comboStructure.ts");

    const targets: ResolvedComboTarget[] = [
      {
        kind: "model",
        stepId: "step-1",
        executionKey: "exec-1",
        modelStr: "claude-web/claude-sonnet-5",
        provider: "claude-web",
        authType: null,
        providerId: null,
        connectionId: null,
        allowedConnectionIds: null,
        weight: 1,
        label: null,
        prompt: null,
        failoverBeforeRetry: undefined,
        fallbackOnlyOnQuotaExhaustion: false,
        trafficType: "production",
      },
      {
        kind: "model",
        stepId: "step-2",
        executionKey: "exec-2",
        modelStr: "claude-web/claude-sonnet-4-6",
        provider: "claude-web",
        authType: null,
        providerId: null,
        connectionId: null,
        allowedConnectionIds: null,
        weight: 1,
        label: null,
        prompt: null,
        failoverBeforeRetry: undefined,
        fallbackOnlyOnQuotaExhaustion: false,
        trafficType: "production",
      },
    ];
    const body = {
      messages: [{ role: "user", content: "read file" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "read file contents",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    };

    const dummyLog: ComboLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const kept = filterTargetsByRequestCompatibility(targets, body, dummyLog);
    assert.equal(kept.length, 2);
    assert.deepEqual(
      kept.map((t) => t.modelStr),
      ["claude-web/claude-sonnet-5", "claude-web/claude-sonnet-4-6"]
    );

    const exhaustion = describeCapabilityFilterExhaustion(targets, body, "claude-sonnet-5-web");
    assert.equal(exhaustion, null);
  });
});
