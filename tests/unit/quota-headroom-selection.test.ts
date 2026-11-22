import { test } from "node:test";
import assert from "node:assert/strict";
import { selectQuotaHeadroomConnection } from "../../src/sse/services/auth.ts";

test("selectQuotaHeadroomConnection prefers least-used account among available candidates", async () => {
  const now = Date.now();
  const candidates = [
    {
      id: "conn-1",
      provider: "claude-web",
      isActive: true,
      rateLimitedUntil: null,
      recentRequestCount: 15,
      lastUsedAt: new Date(now - 1000).toISOString(),
    },
    {
      id: "conn-2",
      provider: "claude-web",
      isActive: true,
      rateLimitedUntil: null,
      recentRequestCount: 2,
      lastUsedAt: new Date(now - 2000).toISOString(),
    },
    {
      id: "conn-3",
      provider: "claude-web",
      isActive: true,
      rateLimitedUntil: null,
      recentRequestCount: 8,
      lastUsedAt: new Date(now - 500).toISOString(),
    },
  ];

  const picked = selectQuotaHeadroomConnection(candidates);
  assert.equal(
    picked?.id,
    "conn-2",
    "Should pick conn-2 which has the lowest recent request count (most headroom)"
  );
});

test("selectQuotaHeadroomConnection never selects an exhausted account before reset time", async () => {
  const future = Date.now() + 3600 * 1000;
  const candidates = [
    {
      id: "conn-exhausted",
      provider: "claude-web",
      isActive: true,
      rateLimitedUntil: new Date(future).toISOString(),
      recentRequestCount: 0,
    },
    {
      id: "conn-active",
      provider: "claude-web",
      isActive: true,
      rateLimitedUntil: null,
      recentRequestCount: 10,
    },
  ];

  const picked = selectQuotaHeadroomConnection(candidates);
  assert.equal(
    picked?.id,
    "conn-active",
    "Must never select an account with active rateLimitedUntil"
  );
});
