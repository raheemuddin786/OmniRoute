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
} from "../../open-sse/services/spb/outboundEvaluator.ts";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";
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
