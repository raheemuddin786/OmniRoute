import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-post-usage-debounce-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "debounce-test-secret-key";

// Use a small delay for timer testing if needed
process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = "50";

const {
  notifyProviderUsageRecorded,
  __resetPostUsageRefreshStateForTests,
  __getPendingPostUsageRefreshesForTests,
  __getLastPostUsageRefreshAtForTests,
} = await import("../../src/lib/usage/providerLimits.ts");

test.after(async () => {
  await cleanupTempDataDir(TEST_DATA_DIR);
});

test.beforeEach(() => {
  __resetPostUsageRefreshStateForTests();
});

test("ignores non-antigravity providers and missing connection IDs", () => {
  const pending = __getPendingPostUsageRefreshesForTests();

  notifyProviderUsageRecorded("openai", "conn-1");
  notifyProviderUsageRecorded("anthropic", "conn-2");
  notifyProviderUsageRecorded("github", "conn-3");
  notifyProviderUsageRecorded(null, "conn-4");
  notifyProviderUsageRecorded(undefined, "conn-5");
  notifyProviderUsageRecorded("antigravity", "");
  notifyProviderUsageRecorded("antigravity", null as unknown as string);

  assert.equal(
    pending.size,
    0,
    "No pending refresh should be scheduled for non-antigravity providers"
  );
});

test("schedules pending post-usage refresh for antigravity and agy", () => {
  const pending = __getPendingPostUsageRefreshesForTests();

  notifyProviderUsageRecorded("antigravity", "conn-ag-1");
  assert.ok(pending.has("conn-ag-1"), "conn-ag-1 should be scheduled");

  notifyProviderUsageRecorded("agy", "conn-agy-2");
  assert.ok(pending.has("conn-agy-2"), "conn-agy-2 should be scheduled");
  assert.equal(pending.size, 2);
});

test("deduplicates in-flight post-usage refresh for the same connection", () => {
  const pending = __getPendingPostUsageRefreshesForTests();

  notifyProviderUsageRecorded("antigravity", "conn-burst");
  assert.equal(pending.size, 1);
  assert.ok(pending.has("conn-burst"));

  // Subsequent notifications while still in-flight must not add duplicates
  notifyProviderUsageRecorded("antigravity", "conn-burst");
  notifyProviderUsageRecorded("agy", "conn-burst");
  assert.equal(pending.size, 1);
});

test("debounces notifications if a refresh occurred within 5 minutes (MIN_QUOTA_REFRESH_INTERVAL_MS)", () => {
  const pending = __getPendingPostUsageRefreshesForTests();
  const lastRefreshMap = __getLastPostUsageRefreshAtForTests();

  const now = Date.now();
  // Simulate a refresh that ran 1 minute ago (within the 5-minute window)
  lastRefreshMap.set("conn-recent", now - 60_000);

  notifyProviderUsageRecorded("antigravity", "conn-recent");
  assert.equal(pending.size, 0, "Should be skipped because recent refresh occurred 1m ago");
  assert.ok(!pending.has("conn-recent"));
});

test("allows scheduling if the previous refresh occurred more than 5 minutes ago", () => {
  const pending = __getPendingPostUsageRefreshesForTests();
  const lastRefreshMap = __getLastPostUsageRefreshAtForTests();

  const now = Date.now();
  // Simulate a refresh that ran 6 minutes ago (outside the 5-minute window)
  lastRefreshMap.set("conn-old", now - 360_000);

  notifyProviderUsageRecorded("antigravity", "conn-old");
  assert.equal(pending.size, 1);
  assert.ok(pending.has("conn-old"), "Should be scheduled because 6 minutes have passed");
});
