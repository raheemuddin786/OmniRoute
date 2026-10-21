import test from "node:test";
import assert from "node:assert/strict";
import { isProviderConnectionUsable } from "../../../src/lib/guardrails/visionBridgeCredentials.ts";
import {
  isProviderQuotaExhausted,
  applyComboTargetExhaustion,
} from "../../../open-sse/services/combo/targetExhaustion.ts";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";
import {
  setQuotaCache,
  __clearForTests as clearQuotaCache,
} from "../../../src/domain/quotaCache.ts";
import { lockModel, clearAllModelLockouts } from "@omniroute/open-sse/services/accountFallback.ts";

test("isProviderConnectionUsable rejects connections in cooldown or rate limited", () => {
  const healthy = {
    id: "conn-1",
    authType: "apikey",
    apiKey: "sk-test",
    testStatus: "active",
  };
  assert.equal(isProviderConnectionUsable(healthy, "openai", "gpt-4o"), true);

  const futureCooldown = new Date(Date.now() + 60_000).toISOString();
  const rateLimited = {
    id: "conn-2",
    authType: "apikey",
    apiKey: "sk-test",
    testStatus: "active",
    rateLimitedUntil: futureCooldown,
  };
  assert.equal(isProviderConnectionUsable(rateLimited, "openai", "gpt-4o"), false);
});

test("isProviderConnectionUsable rejects connection when quota is cached as exhausted", () => {
  clearQuotaCache();
  const connId = "conn-exhausted-1";
  setQuotaCache(
    connId,
    "kilocode",
    {
      requests: { remainingPercentage: 0, resetAt: new Date(Date.now() + 300_000).toISOString() },
    },
    {}
  );

  const conn = {
    id: connId,
    authType: "apikey",
    apiKey: "sk-test",
    testStatus: "active",
  };
  assert.equal(isProviderConnectionUsable(conn, "kilocode", "openrouter/free"), false);
  clearQuotaCache();
});

test("isProviderConnectionUsable rejects connection when model is locked out", () => {
  clearAllModelLockouts();
  const connId = "conn-locked-1";
  lockModel("kilocode", connId, "openrouter/free", 60_000);

  const conn = {
    id: connId,
    authType: "apikey",
    apiKey: "sk-test",
    testStatus: "active",
  };
  assert.equal(isProviderConnectionUsable(conn, "kilocode", "openrouter/free"), false);
  clearAllModelLockouts();
});

test("isProviderQuotaExhausted flags provider exhausted on all-accounts-exhausted errorText", () => {
  const result = isProviderQuotaExhausted("kilocode", {
    rawModel: "openrouter/free",
    result: { status: 429 },
    fallbackResult: {},
    errorText:
      "[kilocode/openrouter/free] All kilocode accounts have exhausted their quota (cached quota state, no upstream attempt; earliest reset after 5m) (reset after 5m)",
    allAccountsRateLimited: false,
    requestScopedFailure: false,
  });
  assert.equal(result, true);
});

test("applyComboTargetExhaustion marks exhaustedProviders on all-accounts quota exhaustion for kilocode", () => {
  const exhaustedProviders = new Set<string>();
  const exhaustedConnections = new Set<string>();
  const transientRateLimitedProviders = new Set<string>();

  const target: ResolvedComboTarget = {
    kind: "model",
    provider: "kilocode",
    modelStr: "kilocode/openrouter/free",
    executionKey: "k1",
    connectionId: "conn-k1",
  };

  const outcome = applyComboTargetExhaustion(target, {
    result: { status: 429 },
    fallbackResult: {},
    errorText:
      "All kilocode accounts have exhausted their quota (cached quota state, no upstream attempt; earliest reset after 5m)",
    rawModel: "openrouter/free",
    isTokenLimitBreach: false,
    allAccountsRateLimited: true,
    requestScopedFailure: false,
    sets: {
      exhaustedProviders,
      exhaustedConnections,
      transientRateLimitedProviders,
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    tag: "COMBO",
    exhaustedLogLevel: "info",
  });

  assert.equal(outcome.providerExhausted, true);
  assert.ok(exhaustedProviders.has("kilocode"));
});
