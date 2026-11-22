import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccountUnavailable, isModelLocked } from "../../open-sse/services/accountFallback.ts";

test("SPB tier selection skips unavailable/locked member and selects available sibling", async () => {
  const future = Date.now() + 3600 * 1000;
  const roster = [
    {
      modelStr: "claude-web/claude-sonnet-5-5",
      connectionId: "conn-1",
      rateLimitedUntil: new Date(future).toISOString(),
    },
    { modelStr: "claude-web/claude-opus-4", connectionId: "conn-2", rateLimitedUntil: null },
  ];

  // Helper simulating the tier roster walk
  let selected: string | null = null;
  for (const candidate of roster) {
    if (candidate.rateLimitedUntil && isAccountUnavailable(candidate.rateLimitedUntil)) {
      continue;
    }
    if (isModelLocked("claude-web", candidate.connectionId, candidate.modelStr)) {
      continue;
    }
    selected = candidate.modelStr;
    break;
  }

  assert.equal(
    selected,
    "claude-web/claude-opus-4",
    "First member in cooldown should be skipped, selecting second member"
  );
});

test("SPB tier selection falls through when all members in a tier are cooled down", async () => {
  const future = Date.now() + 3600 * 1000;
  const tierApex = [
    { modelStr: "claude-web/claude-sonnet-5-5", rateLimitedUntil: new Date(future).toISOString() },
  ];
  const tierResilient = [{ modelStr: "openai/gpt-4o", rateLimitedUntil: null }];

  const tiers = [tierApex, tierResilient];
  let selected: string | null = null;

  for (const tier of tiers) {
    for (const candidate of tier) {
      if (candidate.rateLimitedUntil && isAccountUnavailable(candidate.rateLimitedUntil)) {
        continue;
      }
      selected = candidate.modelStr;
      break;
    }
    if (selected) break;
  }

  assert.equal(
    selected,
    "openai/gpt-4o",
    "Fully cooled tier must fall through to next available tier"
  );
});
