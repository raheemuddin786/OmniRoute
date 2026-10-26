import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { providerUsesCuratedModelsOnly } from "../../src/lib/providers/modelListingCapability.ts";
import {
  ClaudeWebExecutor,
  __clearClaudeWebOrgCacheForTesting,
} from "../../open-sse/executors/claude-web.ts";
import { normalizeClaudeWebModel } from "../../open-sse/executors/claude-web/payload.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";
import { __setTlsFetchOverrideForTesting } from "../../open-sse/services/claudeTlsClient.ts";
import { applyComboTargetExhaustion } from "../../open-sse/services/combo/targetExhaustion.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";
import type { ApplyComboTargetExhaustionOptions } from "../../open-sse/services/combo/targetExhaustion.ts";

describe("Claude Web Stability & Model Resolution Architecture", () => {
  beforeEach(() => {
    __clearClaudeWebOrgCacheForTesting();
    __setTlsFetchOverrideForTesting(null);
  });

  it("classifies claude-web as curated-models-only provider", () => {
    assert.equal(providerUsesCuratedModelsOnly("claude-web"), true);
    assert.equal(providerUsesCuratedModelsOnly("cw"), false); // alias check
    assert.equal(providerUsesCuratedModelsOnly("chatgpt-web"), true);
  });

  it("resolves latest Claude 5 models without falling back to default", () => {
    assert.equal(normalizeClaudeWebModel("claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(normalizeClaudeWebModel("claude-sonnet-5-5"), "claude-sonnet-5-5");
    assert.equal(
      normalizeClaudeWebModel("claude-web/claude-haiku-5-5"),
      "claude-haiku-4-5-20251001"
    );
  });

  it("caches organizationId across multiple calls to avoid rate-limiting claude.ai/api/organizations", async () => {
    let fetchCount = 0;
    __setTlsFetchOverrideForTesting(async (url: string) => {
      if (url === "https://claude.ai/api/organizations") {
        fetchCount++;
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: JSON.stringify([{ id: "org-uuid-test-12345" }]),
          body: null,
        };
      }
      return {
        status: 200,
        headers: new Headers(),
        text: "ok",
        body: null,
      };
    });

    const executor = new ClaudeWebExecutor();
    const input = {
      model: "claude-web/claude-sonnet-4-6",
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: { apiKey: "sessionKey=sk-ant-sid01-test-token" },
    };

    // First execution triggers organization discovery
    await executor.execute(input as unknown as ExecuteInput);
    assert.equal(fetchCount, 1, "First execution must query organizations");

    // Second execution must hit in-memory cache and NOT query organizations
    await executor.execute(input as unknown as ExecuteInput);
    assert.equal(fetchCount, 1, "Second execution with same cookie must use cached organizationId");

    // Third execution with same cookie must also use cache
    await executor.execute(input as unknown as ExecuteInput);
    assert.equal(fetchCount, 1, "Third execution with same cookie must use cached organizationId");

    // Execution with different cookie must trigger a new fetch
    const input2 = {
      ...input,
      credentials: { apiKey: "sessionKey=sk-ant-sid01-another-account" },
    };
    await executor.execute(input2 as unknown as ExecuteInput);
    assert.equal(fetchCount, 2, "Different cookie must fetch its own organizationId");
  });

  it("treats claude-web 429 quota exhaustion as connection-scoped in combo routing", () => {
    const sets = {
      exhaustedProviders: new Set<string>(),
      exhaustedConnections: new Set<string>(),
      transientRateLimitedProviders: new Set<string>(),
      transientRateLimitedConnections: new Set<string>(),
    };

    const target: ResolvedComboTarget = {
      provider: "claude-web",
      model: "claude-sonnet-4-6",
      connectionId: "conn-claude-web-1",
      strategy: "priority",
      index: 0,
      format: "openai",
      prompt: null,
      failoverBeforeRetry: undefined,
      fallbackOnlyOnQuotaExhaustion: false,
      trafficType: "production",
    };

    const opts: ApplyComboTargetExhaustionOptions = {
      result: { status: 429, headers: null },
      fallbackResult: { cooldownMs: 3600000, reason: "quota_exhausted" },
      errorText: "You have reached your usage limit until 4:00 PM",
      rawModel: "claude-web/claude-sonnet-4-6",
      isTokenLimitBreach: false,
      allAccountsRateLimited: false,
      requestScopedFailure: false,
      sets,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      tag: "COMBO",
      exhaustedLogLevel: "info",
    };

    const outcome = applyComboTargetExhaustion(target, opts);

    assert.equal(outcome.isConnectionScopedClaudeQuota, true);
    // Connection 1 must be marked exhausted
    assert.equal(sets.exhaustedConnections.has("claude-web:conn-claude-web-1"), true);
    // But the whole provider claude-web must NOT be permanently poisoned, so sibling connection 2 remains eligible
    assert.equal(sets.exhaustedProviders.has("claude-web"), false);
  });
});
