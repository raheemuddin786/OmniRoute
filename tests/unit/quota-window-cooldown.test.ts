import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProviderQuotaCooldownMs,
  setProviderQuotaOverrides,
} from "../../open-sse/services/providerDefaultRateLimit.ts";

test("resolveProviderQuotaCooldownMs honors explicit retryAfterMs", () => {
  const threeHoursMs = 3 * 60 * 60 * 1000;
  const resolved = resolveProviderQuotaCooldownMs({
    provider: "claude-web",
    retryAfterMs: threeHoursMs,
    isQuotaExhausted: true,
  });
  assert.equal(resolved, threeHoursMs, "Explicit retryAfterMs must take precedence");
});

test("resolveProviderQuotaCooldownMs uses configured quota window for quota-window provider with no reset time", () => {
  // Test default for quota-window / web-cookie provider (5 hours = 18,000,000ms)
  const defaultCooldown = resolveProviderQuotaCooldownMs({
    provider: "claude-web",
    retryAfterMs: null,
    isQuotaExhausted: true,
  });
  assert.equal(defaultCooldown, 5 * 60 * 60 * 1000, "Default quota window must be 5h (18000000ms)");

  // Test custom override in settings
  setProviderQuotaOverrides({
    "claude-web": { quotaWindowSeconds: 2 * 3600 },
  });
  const customCooldown = resolveProviderQuotaCooldownMs({
    provider: "claude-web",
    retryAfterMs: null,
    isQuotaExhausted: true,
  });
  assert.equal(
    customCooldown,
    2 * 3600 * 1000,
    "Should use configured quotaWindowSeconds from override"
  );

  // Reset overrides
  setProviderQuotaOverrides(null);
});

test("resolveProviderQuotaCooldownMs preserves transient cooldown when not quota-exhausted", () => {
  const transientCooldown = resolveProviderQuotaCooldownMs({
    provider: "claude-web",
    retryAfterMs: null,
    isQuotaExhausted: false,
  });
  // Transient 429 keeps standard short cooldown (60s default for oauth/web, not 5h)
  assert.equal(transientCooldown, 60_000, "Transient 429 should retain standard 60s cooldown");
});
