import test from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  maybeCcrReplace,
  retrieveBlock,
  resetCcrStore,
  DEFAULT_MIN_CHARS,
  RETRIEVAL_RAMP_FACTOR_DEFAULT,
} from "../../open-sse/services/compression/engines/ccr/index.ts";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
import { __resetSpbStateInitForTests } from "../../src/lib/db/spbState.ts";
import { saveTierConfig } from "../../src/lib/db/tierConfig.ts";
import { setTierConfig } from "../../open-sse/services/tierResolver.ts";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig.ts";

test.before(() => {
  saveTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbEnabled: true,
    tierModels: {
      apex: ["claude-3-5-sonnet"],
      resilient: ["gpt-4o"],
      local: ["llama-3.1-8b"],
    },
  });
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbEnabled: true,
    tierModels: {
      apex: ["claude-3-5-sonnet"],
      resilient: ["gpt-4o"],
      local: ["llama-3.1-8b"],
    },
  });
});

test.after(() => {
  resetCcrStore();
  __resetSpbStateInitForTests();
  resetDbInstance();
});

test("CCR: text below minChars is not replaced", () => {
  const shortText = "Small prompt under 600 characters for test.";
  const result = maybeCcrReplace(
    shortText,
    DEFAULT_MIN_CHARS,
    "test_principal",
    RETRIEVAL_RAMP_FACTOR_DEFAULT
  );

  assert.equal(result.replaced, false);
  assert.equal(result.text, shortText);
  assert.equal(result.hash, null);
});

test("CCR: text >= 600 characters is replaced with marker and retrievable verbatim", () => {
  const principalId = `test_principal_${Date.now()}`;
  // Generate large compiler output / tool log > 600 chars
  const largeOutput =
    "FAIL src/auth/gate.test.ts\n" +
    "  ✕ should reject unauthenticated requests (45ms)\n" +
    "    Expected: 401\n" +
    "    Received: 500\n" +
    "    Stack trace: Error: Connection failed at AuthGate.verify (/src/auth/gate.ts:42:15)\n" +
    "      at processTicksAndRejections (node:internal/process/task_queues:95:5)\n".repeat(10);

  assert.ok(largeOutput.length >= DEFAULT_MIN_CHARS);

  const result = maybeCcrReplace(
    largeOutput,
    DEFAULT_MIN_CHARS,
    principalId,
    RETRIEVAL_RAMP_FACTOR_DEFAULT
  );

  assert.equal(result.replaced, true);
  assert.ok(result.hash);
  assert.ok(result.text.includes("[CCR retrieve hash="));
  assert.ok(result.text.length < largeOutput.length);

  // Retrieve verbatim block
  const retrieved = retrieveBlock(result.hash!, principalId);
  assert.equal(retrieved, largeOutput);
});

test("CCR: processSmartProxyRouting offloads large tool results on ingress", async () => {
  const sessionId = `spb_ccr_session_${Date.now()}`;
  const largeToolResult =
    "Detailed execution trace with many lines and diagnostics:\n" +
    "Line 1: compile target tsconfig.json\n" +
    "Line 2: typecheck complete with 0 errors\n" +
    "Line 3: running test suite with 42 test cases across 8 workers\n".repeat(15);

  assert.ok(largeToolResult.length >= DEFAULT_MIN_CHARS);

  const decision = await processSmartProxyRouting({
    sessionId,
    messages: [
      { role: "system", content: "You are an expert developer." },
      { role: "user", content: "Analyze the build logs and summarize issues." },
      { role: "tool", content: largeToolResult },
    ],
  });

  assert.ok(decision.intent);
  assert.ok(decision.tierAssignment);
  assert.ok(decision.selectedModel);
});
