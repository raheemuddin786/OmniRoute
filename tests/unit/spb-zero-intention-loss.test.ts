import test from "node:test";
import assert from "node:assert/strict";
import {
  enhanceInboundPrompt,
  evaluateRequestNecessity,
  computePatternHash,
} from "../../open-sse/services/spb/inboundIntelligence.ts";
import {
  evaluateResponseIntent,
  extractResponseContent,
  processSpbOutboundZeroLoss,
  pruneOldToolOutputsForReprompt,
} from "../../open-sse/services/spb/outboundEvaluator.ts";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
import { expandIncomingCcrMarkers } from "../../open-sse/services/compression/engines/ccr/index.ts";
import { persistCcrBlock } from "../../src/lib/db/ccrBlocks.ts";
import {
  saveLearnedOptimization,
  getLearnedOptimization,
  recordIntentEvaluation,
  recordConfirmationGate,
  __resetSpbStateInitForTests,
} from "../../src/lib/db/spbState.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { setTierConfig } from "../../open-sse/services/tierResolver.ts";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig.ts";

test.before(() => {
  setTierConfig({
    ...DEFAULT_TIER_CONFIG,
    spbEnabled: true,
    tierModels: {
      apex: ["test-apex-model"],
      resilient: ["test-resilient-model"],
      local: ["test-local-model"],
    },
  });
});

test.after(() => {
  __resetSpbStateInitForTests();
  resetDbInstance();
});

test("evaluateRequestNecessity flags empty or void content", () => {
  const result = evaluateRequestNecessity([], "");
  assert.equal(result.isNecessary, false);
  assert.equal(result.isRedundant, true);
  assert.equal(result.confirmationRequired, true);
  assert.match(result.reason || "", /empty or void/i);
});

test("evaluateRequestNecessity flags exact repetition from preceding turn", () => {
  const repeatedText =
    "Please write a comprehensive distributed rate limiter implementation in TypeScript.";
  const messages = [
    { role: "user", content: repeatedText },
    { role: "assistant", content: "Sure, here is the code." },
  ];
  const result = evaluateRequestNecessity(messages, repeatedText);
  assert.equal(result.isNecessary, false);
  assert.equal(result.isRedundant, true);
  assert.equal(result.confirmationRequired, true);
  assert.match(result.reason || "", /duplicate request detected/i);
});

test("evaluateRequestNecessity passes valid non-redundant requests", () => {
  const messages = [
    { role: "user", content: "Can you analyze src/index.ts?" },
    { role: "assistant", content: "I analyzed the file." },
  ];
  const result = evaluateRequestNecessity(messages, "Now add unit tests for index.ts.");
  assert.equal(result.isNecessary, true);
  assert.equal(result.isRedundant, false);
  assert.equal(result.confirmationRequired, false);
});

test("enhanceInboundPrompt adds Tier 1 Apex Architectural Invariant Framing", () => {
  const prompt = "Design the data sync protocol between cloud agents and local nodes.";
  const result = enhanceInboundPrompt(prompt, "tier_1_apex", "ARCHITECTURAL_PLANNING", [
    { role: "user", content: prompt },
  ]);

  assert.equal(result.tier, "tier_1_apex");
  assert.ok(result.enhancedPrompt.includes("SPB-IR Apex Directive"));
  assert.ok(result.appliedOptimizations.includes("Tier 1 Apex Architectural Invariant Framing"));
  assert.ok(result.preservedIntentions.length > 0);
  assert.ok(result.enhancedPrompt.includes(prompt));
});

test("enhanceInboundPrompt adds Tier 2 Resilient Implementation Framing", () => {
  const prompt = "Implement the retry with exponential backoff algorithm in executor.ts.";
  const result = enhanceInboundPrompt(prompt, "tier_2_resilient", "CODE_GENERATION", [
    { role: "user", content: prompt },
  ]);

  assert.equal(result.tier, "tier_2_resilient");
  assert.ok(result.enhancedPrompt.includes("SPB-IR Resilient Directive"));
  assert.ok(
    result.appliedOptimizations.includes(
      "Tier 2 Resilient Implementation & Error Boundary Enforcement"
    )
  );
  assert.ok(result.enhancedPrompt.includes(prompt));
});

test("enhanceInboundPrompt adds Tier 3 Local Directive Framing", () => {
  const prompt = "Format this function and fix indentation.";
  const result = enhanceInboundPrompt(prompt, "tier_3_local", "FAST_REFACTOR", [
    { role: "user", content: prompt },
  ]);

  assert.equal(result.tier, "tier_3_local");
  assert.ok(result.enhancedPrompt.includes("SPB-IR Local Directive"));
  assert.ok(
    result.appliedOptimizations.includes(
      "Tier 3 Surgical Scope & Deterministic Boundary Confinement"
    )
  );
  assert.ok(result.enhancedPrompt.includes(prompt));
});

test("evaluateResponseIntent flags lazy placeholders (TODO / FIXME / omitted)", () => {
  const prompt = "Write a complete JWT validator in TypeScript with tests.";
  const lazyResponse = `
    function validateJwt(token: string) {
      // TODO: implement later
      // ...rest of code...
    }
  `;
  const result = evaluateResponseIntent(
    prompt,
    ["JWT validation", "Tests"],
    lazyResponse,
    "tier_2_resilient",
    "CODE_GENERATION",
    "test_sess_lazy"
  );

  assert.equal(result.isSatisfied, false);
  assert.ok(result.satisfactionScore < 0.85);
  assert.ok(result.oddities.length > 0);
  assert.ok(
    result.suggestedReprompt &&
      result.suggestedReprompt.includes("incomplete or contained omissions")
  );
});

test("evaluateResponseIntent approves complete production response", () => {
  const prompt = "Write a simple math utility function with tests.";
  const completeResponse = `
    export function add(a: number, b: number): number {
      return a + b;
    }

    describe("add", () => {
      it("adds two numbers", () => {
        expect(add(2, 3)).toBe(5);
      });
    });
  `;
  const result = evaluateResponseIntent(
    prompt,
    ["Math utility", "Tests"],
    completeResponse,
    "tier_2_resilient",
    "CODE_GENERATION",
    "test_sess_complete"
  );

  assert.equal(result.isSatisfied, true);
  assert.ok(result.satisfactionScore >= 0.85);
  assert.equal(result.omissions.length, 0);
  assert.equal(result.suggestedReprompt, undefined);
});

test("processSmartProxyRouting attaches enhancement and necessity evaluation", async () => {
  const sessionId = "spb_test_zero_loss_" + Date.now();
  const decision = await processSmartProxyRouting({
    sessionId,
    messages: [
      {
        role: "user",
        content: "Please architect a high-availability event mesh with fault-tolerant recovery.",
      },
    ],
  });

  assert.equal(decision.intent.taskPhase, "ARCHITECTURAL_PLANNING");
  assert.equal(decision.tierAssignment.tier, "tier_1_apex");
  assert.ok(decision.enhancement);
  assert.ok(decision.enhancement.enhancedPrompt.includes("SPB-IR Apex Directive"));
  assert.ok(decision.necessity);
  assert.equal(decision.necessity.isNecessary, true);
  assert.equal(decision.necessity.confirmationRequired, false);
});

test("SQLite persistence: learned optimizations and confirmation gates", () => {
  const patternHash = computePatternHash(
    "Write unit tests for authentication",
    "TESTING_AND_VERIFICATION"
  );

  const saveSuccess = saveLearnedOptimization({
    patternHash,
    tier: "tier_2_resilient",
    taskPhase: "TESTING_AND_VERIFICATION",
    optimizationStrategy: "test_driven_contract_injection",
    enhancementTemplate: "Inject mock fixtures and edge condition assertions",
    successCount: 5,
    failureCount: 0,
    avgSatisfactionScore: 0.98,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(saveSuccess, true);

  const retrieved = getLearnedOptimization(patternHash);
  assert.ok(retrieved);
  assert.equal(retrieved.patternHash, patternHash);
  assert.equal(retrieved.tier, "tier_2_resilient");
  assert.equal(retrieved.optimizationStrategy, "test_driven_contract_injection");
  assert.ok(retrieved.avgSatisfactionScore >= 0.95);

  const gateSuccess = recordConfirmationGate({
    sessionId: "test_sess_gate",
    promptHash: patternHash,
    reason: "Duplicate prompt detected",
    suggestedAction: "Confirm re-run",
    status: "PENDING",
    createdAt: Date.now(),
  });
  assert.equal(gateSuccess, true);

  const evalSuccess = recordIntentEvaluation({
    sessionId: "test_sess_eval",
    promptAnchorHash: patternHash,
    tier: "tier_2_resilient",
    taskPhase: "TESTING_AND_VERIFICATION",
    satisfactionScore: 0.95,
    detectedOmissions: "[]",
    repromptCount: 0,
    repromptSuccess: true,
    evaluatedAt: Date.now(),
  });
  assert.equal(evalSuccess, true);
});

test("enhanceInboundPrompt resolves novice shorthand from conversation context", () => {
  const contextMessages = [
    { role: "user", content: "Check the auth flow in src/lib/auth.ts." },
    { role: "assistant", content: "I ran the test and encountered an error." },
    { role: "tool", content: "TypeError: Cannot read properties of undefined (reading 'verify')" },
  ];

  const novicePrompt = "fix it";
  const result = enhanceInboundPrompt(
    novicePrompt,
    "tier_2_resilient",
    "CODE_GENERATION",
    contextMessages
  );

  assert.ok(result.enhancedPrompt.includes("TypeError: Cannot read properties of undefined"));
  assert.ok(result.enhancedPrompt.includes("src/lib/auth.ts"));
  assert.ok(
    result.appliedOptimizations.includes("Novice Shorthand Ambiguity Resolution via Error Trace")
  );
  assert.ok(result.enhancedPrompt.includes("SPB-IR Resilient Directive"));
});

test("extractResponseContent extracts full text from SSE streams", async () => {
  const ssePayload = [
    'data: {"choices":[{"delta":{"content":"export function "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"validateToken() { return true; }"}}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ssePayload));
      controller.close();
    },
  });

  const response = new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });

  const extracted = await extractResponseContent(response);
  assert.equal(extracted.isStream, true);
  assert.equal(extracted.text, "export function validateToken() { return true; }");
  assert.ok(extracted.rawChunks.length > 0);
});

test("processSpbOutboundZeroLoss autonomously intercepts and re-prompts flawed response", async () => {
  const prompt = "Implement the complete rate limiter in TypeScript with tests.";
  const preservedIntentions = ["Rate limiter", "TypeScript types", "Tests"];

  // First attempt returns lazy placeholders
  const flawedResponse = new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "export class Limiter { // TODO: implement later \n // ...rest of code... }",
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );

  // Second attempt (after re-prompt) returns 100% complete implementation
  let dispatchCallCount = 0;
  const dispatchModelMock = async (_newBody: Record<string, unknown>) => {
    dispatchCallCount++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "export interface Config { rate: number; } export class Limiter { consume() { return true; } } describe('Limiter', () => { it('works', () => { expect(true).toBe(true); }); });",
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const finalResponse = await processSpbOutboundZeroLoss({
    initialResponse: flawedResponse,
    dispatchModel: dispatchModelMock,
    body: { messages: [{ role: "user", content: prompt }] },
    originalPrompt: prompt,
    preservedIntentions,
    tier: "tier_2_resilient",
    taskPhase: "CODE_GENERATION",
    sessionId: "test_reprompt_sess",
    maxReprompts: 2,
  });

  assert.equal(dispatchCallCount, 1, "Expected exactly 1 re-prompt round");
  assert.equal(finalResponse.headers.get("X-OmniRoute-SPB-ZeroLoss"), "verified");
  assert.equal(finalResponse.headers.get("X-OmniRoute-SPB-Reprompt-Count"), "1");

  const json = await finalResponse.json();
  assert.ok(json.choices[0].message.content.includes("export interface Config"));
  assert.ok(!json.choices[0].message.content.includes("TODO"));
});

test("evaluateResponseIntent detects premature truncation and unclosed code blocks", () => {
  const truncatedResponse =
    "Here is the code:\n```typescript\nexport function broken() {\n  return 1;";
  const result = evaluateResponseIntent(
    "Write function broken in TypeScript",
    ["Function"],
    truncatedResponse,
    "tier_2_resilient",
    "CODE_GENERATION",
    "test_truncation"
  );

  assert.equal(result.isSatisfied, false);
  assert.ok(result.oddities.some((o) => o.includes("unclosed code block")));
});

test("evaluateResponseIntent detects apologetic refusal fillers", () => {
  const refusalResponse =
    "As an AI language model, I cannot access your local files or execute code.";
  const result = evaluateResponseIntent(
    "Fix bug in auth.ts",
    ["Bugfix"],
    refusalResponse,
    "tier_2_resilient",
    "CODE_GENERATION",
    "test_refusal"
  );

  assert.equal(result.isSatisfied, false);
  assert.ok(result.oddities.some((o) => o.includes("apologetic refusal filler")));
});

test("pruneOldToolOutputsForReprompt conserves tokens by pruning historical tool outputs", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "Check status" },
    { role: "tool", content: "A".repeat(2000) }, // old tool output (should be truncated)
    { role: "assistant", content: "Analyzing" },
    { role: "tool", content: "B".repeat(1500) }, // recent tool output 2 (kept)
    { role: "tool", content: "C".repeat(1500) }, // recent tool output 1 (kept)
    { role: "user", content: "Implement fix" },
  ];

  const pruned = pruneOldToolOutputsForReprompt(messages);
  assert.equal(pruned.length, messages.length);
  assert.ok((pruned[1].content as string).includes("truncated for token conservation"));
  assert.equal(pruned[3].content, "B".repeat(1500));
  assert.equal(pruned[4].content, "C".repeat(1500));
});

test("processSmartProxyRouting preserves structured tool_result arrays and bypasses confirmation gating", async () => {
  const sessionId = "spb_tool_result_preservation_" + Date.now();
  const toolResultContent = [
    {
      type: "tool_result",
      tool_use_id: "tool_u123",
      content: "Error: Cannot find module './foo'",
    },
  ];
  const decision = await processSmartProxyRouting({
    sessionId,
    messages: [
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "Let me check the files." },
      { role: "user", content: toolResultContent as unknown as string },
    ],
    tools: [{ name: "read_file" }],
  });

  assert.equal(decision.intent.isToolResultTurn, true);
  assert.equal(decision.necessity, undefined);
  assert.equal(decision.enhancedMessages, undefined);
});

test("processSpbOutboundZeroLoss preserves autonomous tool calls without re-prompting", async () => {
  const prompt = "Can you check the TypeScript types and run tests?";
  const toolCallResponse = new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc123",
                type: "function",
                function: { name: "grep_search", arguments: '{"query":"interface"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );

  let dispatchCalled = false;
  const dispatchMock = async () => {
    dispatchCalled = true;
    return new Response(JSON.stringify({ choices: [] }));
  };

  const finalResponse = await processSpbOutboundZeroLoss({
    initialResponse: toolCallResponse,
    dispatchModel: dispatchMock,
    body: {
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "function", function: { name: "grep_search" } }],
    },
    originalPrompt: prompt,
    preservedIntentions: ["TypeScript types", "Tests"],
    tier: "tier_2_resilient",
    taskPhase: "INSPECTION_SYNTHESIS",
    sessionId: "test_tool_call_session",
    maxReprompts: 2,
  });

  assert.equal(dispatchCalled, false, "Should not re-prompt when model produces a tool call");
  assert.equal(finalResponse.headers.get("X-OmniRoute-SPB-Satisfaction"), "1.00");
  assert.equal(finalResponse.headers.get("X-OmniRoute-SPB-Reprompt-Count"), "0");
  const json = await finalResponse.json();
  assert.ok(json.choices[0].message.tool_calls.length > 0);
});

test("processSpbOutboundZeroLoss reconstructs consumed streaming body on upstream dispatch failure", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"function hello() { // TODO"\\n\\n')
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const streamResponse = new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

  // Upstream returns 500 error on re-prompt dispatch
  const failingDispatch = async () => new Response("Internal Server Error", { status: 500 });

  const finalResponse = await processSpbOutboundZeroLoss({
    initialResponse: streamResponse,
    dispatchModel: failingDispatch,
    body: { messages: [{ role: "user", content: "Implement hello" }] },
    originalPrompt: "Implement hello",
    preservedIntentions: ["hello"],
    tier: "tier_2_resilient",
    taskPhase: "CODE_GENERATION",
    sessionId: "test_safety_stream_body",
    maxReprompts: 2,
  });

  // Verify that the body is not empty and can be read
  assert.ok(finalResponse.body, "Stream body must be present and reconstructed");
  const reader = finalResponse.body.getReader();
  let totalChunks = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) totalChunks++;
  }
  assert.ok(totalChunks > 0, "Reconstructed stream must emit data chunks rather than empty body");
});

test("processSmartProxyRouting never corrupts large prior messages with CCR markers in enhancedMessages", async () => {
  const sessionId = "spb_ccr_corruption_guard_" + Date.now();
  const largeCodebaseDump =
    "export class LargeSystem {\n" + "  // substantive code\n".repeat(50) + "}\n";
  const largeGitStatus = "## main...origin/main\n" + " M src/file.ts\n".repeat(40);
  const userPrompt = "Review the architecture and plan next steps";

  const decision = await processSmartProxyRouting({
    sessionId,
    messages: [
      { role: "user", content: largeGitStatus },
      { role: "assistant", content: "I see the changed files." },
      { role: "user", content: largeCodebaseDump },
      { role: "assistant", content: "I have read the codebase dump." },
      { role: "user", content: userPrompt },
    ],
  });

  assert.ok(decision.enhancedMessages, "Expected enhancedMessages to be returned");
  const enhanced = decision.enhancedMessages!;

  // Verify that prior messages are NOT replaced with [CCR retrieve hash=...]
  for (let i = 0; i < enhanced.length - 1; i++) {
    const content = typeof enhanced[i].content === "string" ? (enhanced[i].content as string) : "";
    assert.ok(
      !content.includes("[CCR retrieve hash="),
      `Message at index ${i} was corrupted with a CCR retrieve placeholder: ${content}`
    );
  }
  assert.equal(enhanced[0].content, largeGitStatus, "largeGitStatus must remain verbatim");
  assert.equal(enhanced[2].content, largeCodebaseDump, "largeCodebaseDump must remain verbatim");
});

test("expandIncomingCcrMarkers expands content-addressed CCR markers from durable storage and memory", () => {
  const blockContent =
    "Verbatim original content of a massive instruction block that was previously offloaded.";
  const hash = "abcdef0123456789abcdef01";
  persistCcrBlock({
    principalId: "test_principal_session",
    hash,
    content: blockContent,
    bytes: Buffer.byteLength(blockContent),
    chars: blockContent.length,
    lines: 1,
    contentType: "text/plain",
    source: "compression",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  });

  const replayedMessages = [
    {
      role: "user",
      content: `Preamble text… [CCR retrieve hash=${hash} chars=87]`,
    },
    {
      role: "assistant",
      content: "Understood.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Multi-part instruction… [CCR retrieve hash=${hash} chars=87]`,
        },
      ],
    },
  ];

  const expanded = expandIncomingCcrMarkers(replayedMessages);
  assert.equal(expanded[0].content, blockContent);
  const part = (expanded[2].content as Array<{ type: string; text: string }>)[0];
  assert.equal(part.text, blockContent);
});

test("expandIncomingCcrMarkers cleans legacy directive wrappers and unwraps stringified JSON text arrays", () => {
  const rawTextPart = "System task description for engineering workflow.";
  const stringifiedJson = JSON.stringify([{ type: "text", text: rawTextPart }]);
  const poisonedMessage =
    `[SPB-IR Apex Directive: Provide exhaustive architectural precision, trade-off analysis, zero unverified assumptions, and adherence to system invariants.]\n\n` +
    `${stringifiedJson}\n\n` +
    `[Completion Standard: Output complete, production-ready implementation. Strictly ZERO placeholders, NO '// TODO', and NO truncated code blocks.]`;

  const messages = [{ role: "user", content: poisonedMessage }];
  const cleaned = expandIncomingCcrMarkers(messages);

  assert.equal(typeof cleaned[0].content, "string");
  const content = cleaned[0].content as string;
  assert.ok(!content.includes("SPB-IR Apex Directive"));
  assert.ok(!content.includes("Completion Standard"));
  assert.ok(!content.includes('[{"type":"text"'));
  assert.equal(content, rawTextPart);
});
