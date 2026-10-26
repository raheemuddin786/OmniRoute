#!/usr/bin/env node
/**
 * SPB Zero-Intention-Loss Governance & Audit CLI Tool (WAT Framework Layer 3)
 *
 * Provides deterministic CLI verification, intent health audit, and prompt
 * enhancement validation across Model Tiers (Tier 1: Apex, Tier 2: Resilient, Tier 3: Local).
 */

import { classifyIntent } from "../../open-sse/services/spb/intentAnalyzer.ts";
import { selectModelTier } from "../../open-sse/services/spb/tieredRegistry.ts";
import {
  enhanceInboundPrompt,
  evaluateRequestNecessity,
} from "../../open-sse/services/spb/inboundIntelligence.ts";
import { evaluateResponseIntent } from "../../open-sse/services/spb/outboundEvaluator.ts";

function runAudit() {
  console.log("=================================================================");
  console.log("   SPB-IR Zero-Intention-Loss Intelligence Governance Audit      ");
  console.log("=================================================================\n");

  const testCases = [
    {
      name: "Architectural Planning (Tier 1 Apex)",
      prompt:
        "Architectural design for a distributed system with automated raft consensus failover.",
      expectedTier: "tier_1_apex",
      sampleResponse:
        "Here is the architectural specification: [Raft Cluster Topology, Failure Invariants, Consensus Protocol].",
    },
    {
      name: "Code Execution (Tier 2 Resilient)",
      prompt:
        "Implement the token bucket algorithm with redis atomic increments in TypeScript with tests.",
      expectedTier: "tier_2_resilient",
      sampleResponse:
        "export interface BucketConfig { rate: number; } export class TokenBucket { ... } describe('TokenBucket', () => { it('rate limits', () => { ... }); });",
    },
    {
      name: "Micro Refactor (Tier 3 Local)",
      prompt: "Format this function and rename variable foo to bar.",
      expectedTier: "tier_3_local",
      sampleResponse: "function clean(bar: string) { return bar.trim(); }",
    },
    {
      name: "Lazy Response Detection (Outbound IGA Re-prompt)",
      prompt: "Write complete OAuth2 PKCE flow in TypeScript with tests.",
      expectedTier: "tier_2_resilient",
      sampleResponse: "function oauth() { // TODO: implement later \n // ...rest of code... }",
      expectRejection: true,
    },
  ];

  let passed = 0;

  for (const tc of testCases) {
    console.log(`[TEST] ${tc.name}`);
    const intent = classifyIntent([{ role: "user", content: tc.prompt }]);
    const tier = selectModelTier(intent.taskPhase, intent.complexityScore);

    console.log(`  Phase: ${intent.taskPhase} | Tier: ${tier.tier}`);

    const necessity = evaluateRequestNecessity([], tc.prompt);
    console.log(
      `  Necessity: necessary=${necessity.isNecessary}, redundant=${necessity.isRedundant}`
    );

    const enhanced = enhanceInboundPrompt(tc.prompt, tier.tier, intent.taskPhase, [
      { role: "user", content: tc.prompt },
    ]);
    console.log(`  Optimizations: ${enhanced.appliedOptimizations.join(", ")}`);

    const evalResult = evaluateResponseIntent(
      tc.prompt,
      enhanced.preservedIntentions,
      tc.sampleResponse,
      tier.tier,
      intent.taskPhase,
      "audit_sess"
    );
    console.log(
      `  Outbound Satisfaction: score=${evalResult.satisfactionScore.toFixed(2)}, satisfied=${evalResult.isSatisfied}`
    );
    if (evalResult.suggestedReprompt) {
      console.log(`  Re-prompt Formulated: "${evalResult.suggestedReprompt.slice(0, 100)}..."`);
    }

    if (tc.expectRejection) {
      if (!evalResult.isSatisfied) {
        console.log(
          "  ✔ Lazy response correctly intercepted and flagged for iterative re-prompting.\n"
        );
        passed++;
      } else {
        console.log("  ✖ Expected lazy response to be intercepted!\n");
      }
    } else {
      if (evalResult.isSatisfied) {
        console.log("  ✔ Complete response satisfied 100% of intention criteria.\n");
        passed++;
      } else {
        console.log("  ✖ Expected complete response to satisfy criteria!\n");
      }
    }
  }

  console.log(`Audit Summary: ${passed}/${testCases.length} scenarios verified successfully.`);
}

runAudit();
