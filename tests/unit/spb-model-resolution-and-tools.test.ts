import test from "node:test";
import assert from "node:assert/strict";
import {
  supportsToolCalling,
  getResolvedModelCapabilities,
} from "../../src/lib/modelCapabilities.ts";
import { resolveVirtualTierModels } from "../../open-sse/services/tierResolver.ts";

test("devin-cli never admits tool calling across base and suffixed variants", () => {
  // devin-cli is summarizer only (finish_reason: 'stop', no tools)
  assert.equal(supportsToolCalling("devin-cli/claude-fable-5-1-max"), false);
  assert.equal(supportsToolCalling("devin-cli/claude-fable-5-1-max-low"), false);
  assert.equal(supportsToolCalling("devin-cli/claude-fable-5-1-max-high"), false);
  assert.equal(supportsToolCalling("dv/claude-fable-5-1-max-low"), false);

  const capsObj = getResolvedModelCapabilities({
    provider: "devin-cli",
    model: "claude-fable-5-1-max-low",
  });
  assert.equal(capsObj.toolCalling, false);

  const capsStr = getResolvedModelCapabilities("devin-cli/claude-fable-5-1-max-low");
  assert.equal(capsStr.toolCalling, false);
});

test("devin-cli-agentic (dva) supports tool calling", () => {
  assert.equal(supportsToolCalling("dva/swe-1-6-slow"), true);
  assert.equal(supportsToolCalling("devin-cli-agentic/swe-1-6-slow"), true);
});

test("resolveVirtualTierModels maps virtual tier identifiers to concrete candidate models", () => {
  const resilient = resolveVirtualTierModels("resilient/spb-tier-2");
  assert.ok(Array.isArray(resilient));
  assert.ok(resilient.length > 0);
  assert.ok(resilient.every((m) => !m.includes("spb-tier") && !m.startsWith("resilient/")));

  const apex = resolveVirtualTierModels("apex/spb-tier-1");
  assert.ok(Array.isArray(apex));
  assert.ok(apex.length > 0);
  assert.ok(apex.every((m) => !m.includes("spb-tier") && !m.startsWith("apex/")));

  const local = resolveVirtualTierModels("local/spb-tier-3");
  assert.ok(Array.isArray(local));
  assert.ok(local.length > 0);
  assert.ok(local.every((m) => !m.includes("spb-tier") && !m.startsWith("local/")));
});
