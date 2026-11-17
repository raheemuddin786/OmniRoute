import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "omni-cw-vision-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { isVisionModelId, isTextOnlyChatTransport } =
  await import("../../src/shared/constants/visionModels.ts");
const { VisionBridgeGuardrail } = await import("../../src/lib/guardrails/visionBridge.ts");
const { resetGuardrailsForTests } = await import("../../src/lib/guardrails/registry.ts");
const { transformToClaude } = await import("../../open-sse/executors/claude-web/payload.ts");

test.after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.beforeEach(() => {
  resetGuardrailsForTests({ registerDefaults: false });
});

const ANTHROPIC_IMAGE_REQUEST = {
  model: "claude-web/claude-sonnet-5-5",
  messages: [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        },
        {
          type: "text",
          text: "Analyze this diagram",
        },
      ],
    },
  ],
};

test("claude-web transport is recognized as text-only from single source of truth", () => {
  for (const provider of ["claude-web", "cw"]) {
    assert.equal(isTextOnlyChatTransport(provider), true);
    assert.equal(isVisionModelId(`${provider}/claude-sonnet-5-5`), false);
    const caps = getResolvedModelCapabilities({ provider, model: "claude-sonnet-5-5" });
    assert.equal(caps.supportsVision, false);
    assert.deepEqual(caps.modalitiesInput, ["text"]);
  }
});

test("VisionBridgeGuardrail converts image blocks to descriptions for claude-web", async () => {
  let callCount = 0;
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        visionBridgeEnabled: true,
        modalityBridgeVisionMode: "describe",
        visionBridgeModel: "openai/gpt-4o-mini",
        visionBridgePrompt: "Describe concisely",
      }),
      callVisionModel: async () => {
        callCount++;
        return "Diagram showing client-server request pipeline";
      },
      hasUsableCredentials: async () => null,
    },
  });

  const result = await guardrail.preCall(ANTHROPIC_IMAGE_REQUEST, {
    model: "claude-web/claude-sonnet-5-5",
    log: console,
  });

  assert.equal(result.block, false);
  assert.equal(callCount, 1);
  assert.ok(result.modifiedPayload);

  // Pass the guardrail-transformed body to claude-web payload converter
  const claudeWebPayload = transformToClaude(result.modifiedPayload as Record<string, unknown>);
  assert.ok(claudeWebPayload.prompt.includes("Diagram showing client-server request pipeline"));
  assert.ok(
    !claudeWebPayload.prompt.includes("[Image]"),
    "claude-web payload must contain description, not bare [Image]"
  );
});

test("If no bridge model is available, clear error stub is emitted instead of silently sending [Image]", async () => {
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        visionBridgeEnabled: true,
        modalityBridgeVisionMode: "describe",
        visionBridgeModel: "openai/gpt-4o-mini",
      }),
      callVisionModel: async () => {
        throw new Error("No vision-capable provider connected, cannot process image request");
      },
      hasUsableCredentials: async () => false,
    },
  });

  const result = await guardrail.preCall(ANTHROPIC_IMAGE_REQUEST, {
    model: "claude-web/claude-sonnet-5-5",
    log: console,
  });

  assert.equal(result.block, false);
  assert.ok(result.modifiedPayload);

  const claudeWebPayload = transformToClaude(result.modifiedPayload as Record<string, unknown>);
  assert.ok(
    claudeWebPayload.prompt.includes("(unavailable — no vision-capable provider connected)"),
    "claude-web payload must contain explicit error stub indicating vision provider unavailable"
  );
  assert.ok(
    !claudeWebPayload.prompt.includes("[Image]"),
    "must not silently drop to [Image] without error notice"
  );
});

test("If vision bridge is disabled, returns clear error blocking request for claude-web", async () => {
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        visionBridgeEnabled: false,
      }),
    },
  });

  const result = await guardrail.preCall(ANTHROPIC_IMAGE_REQUEST, {
    model: "claude-web/claude-sonnet-5-5",
    log: console,
  });

  assert.equal(result.block, true);
  assert.equal(result.meta?.reason, "vision_bridge_disabled");
  assert.ok(
    result.message?.includes("Vision bridge is disabled"),
    "must return clear error message"
  );
});

test("Without text-only transport override (before fix), claude-web dropped images silently to [Image]", () => {
  // Direct call to claude-web payload transformer without VisionBridge pre-processing
  const claudeWebPayload = transformToClaude(ANTHROPIC_IMAGE_REQUEST);
  assert.ok(
    claudeWebPayload.prompt.includes("[Image]"),
    "Unprocessed image blocks in claude-web fall back to [Image]"
  );
});
