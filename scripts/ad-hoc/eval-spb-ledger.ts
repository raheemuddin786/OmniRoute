/**
 * Ad-Hoc Evaluation Script for SPB Apex Intent Ledger (Requirement G)
 * Evaluates the 11 benchmark prompts from tests/fixtures/spb-ledger-eval.json
 *
 * Usage:
 *   npx tsx scripts/ad-hoc/eval-spb-ledger.ts [--live] [--mock] [--model <model_str>]
 */

import fs from "node:fs";
import path from "node:path";
import {
  expandLedgerWithApex,
  gatherApexContext,
  type ModelDispatchFn,
} from "../../open-sse/services/spb/apexLedger.ts";

interface EvalFixture {
  id: string;
  prompt: string;
  expected: {
    isActionable: boolean;
    minIntents: number;
    layers: string[];
    hasImplied?: boolean;
  };
}

async function runEvaluation() {
  const args = process.argv.slice(2);
  const isMock = args.includes("--mock");
  const modelArgIdx = args.indexOf("--model");
  const chosenModel = modelArgIdx !== -1 ? args[modelArgIdx + 1] : "auto/best-coding";
  const omnirouteKey = process.env.OMNIROUTE_API_KEY;

  const fixturesPath = path.resolve(process.cwd(), "tests/fixtures/spb-ledger-eval.json");
  if (!fs.existsSync(fixturesPath)) {
    console.error(`Fixture file not found: ${fixturesPath}`);
    process.exit(1);
  }

  const fixtures: EvalFixture[] = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

  if (isMock || !omnirouteKey) {
    console.log("================================================================================");
    console.log("[PLUMBING SMOKE TEST ONLY — SYNTHETIC MOCK]");
    console.log("Notice: This run uses synthetic fixtures to verify harness plumbing only.");
    console.log("It does NOT validate model quality, reasoning, or unspoken intent.");
    console.log(
      "================================================================================\n"
    );

    const mockDispatch: ModelDispatchFn = async ({ messages }) => {
      const userMsg = messages.find((m) => m.role === "user")?.content || "";
      const isPureQuestion =
        /\b(?:how do i|what are the trade-offs|ignore all instructions)\b/i.test(userMsg);

      if (isPureQuestion) {
        return JSON.stringify({
          isActionable: false,
          intents: [],
          nonGoals: [],
        });
      }

      const intents = [
        {
          id: "I1",
          text: "Primary task implementation",
          kind: "explicit",
          layer: userMsg.includes("UI") || userMsg.includes("form") ? "ui" : "api",
          targetFiles: ["src/feature.ts"],
          acceptance: "Core implementation satisfies specifications",
        },
        {
          id: "I2",
          text: "Database schema migration and typing",
          kind: "required-implied",
          parentId: "I1",
          reason: "Persistence layer required for data retention",
          layer: "data",
          targetFiles: ["src/lib/db/schema.ts"],
          acceptance: "Migration is idempotent and syntactically valid",
        },
        {
          id: "I3",
          text: "Automated test verification suite",
          kind: "required-implied",
          parentId: "I1",
          reason: "Regression prevention across modified boundaries",
          layer: "test",
          targetFiles: ["tests/unit/feature.test.ts"],
          acceptance: "Test suite runs and passes with zero failures",
        },
      ];

      return JSON.stringify({
        isActionable: true,
        intents,
        nonGoals: ["Do not modify unrelated legacy modules"],
      });
    };

    const context = gatherApexContext({
      workspaceRoot: process.cwd(),
      prompt: "",
    });

    for (let idx = 0; idx < fixtures.length; idx++) {
      const f = fixtures[idx];
      console.log(`[Plumbing Item ${idx + 1}/${fixtures.length}] ID: ${f.id}`);
      console.log(`Prompt: "${f.prompt}"`);

      const res = await expandLedgerWithApex(f.prompt, context, mockDispatch);

      console.log(
        `Returned Mock Ledger (isActionable: ${res.isActionable}, items: ${res.intents.length}):`
      );
      for (const it of res.intents) {
        console.log(
          `  - [${it.id}] (${it.layer}) [${it.kind}] ${it.text} (acceptance: "${it.acceptance}")`
        );
      }
      console.log(
        `[Plumbing Status]: synthetic structure delivered successfully (Verdict: N/A - Mock Mode)`
      );
      console.log(
        "--------------------------------------------------------------------------------"
      );
    }
    console.log(`\nPlumbing Test Summary: Completed ${fixtures.length} synthetic fixtures.\n`);
    return;
  }

  // Live Model Evaluation via OmniRoute
  console.log("================================================================================");
  console.log("SPB APEX LEDGER LIVE MODEL EVALUATION");
  console.log(`Model: ${chosenModel} (via OmniRoute http://localhost:20128)`);
  console.log("Tier: tier_1_apex");
  console.log("Verdict Policy: Manual human inspection (No automated pass/fail)");
  console.log(`Loaded: ${fixtures.length} benchmark fixtures`);
  console.log("================================================================================\n");

  const liveDispatch: ModelDispatchFn = async ({ messages, temperature, max_tokens }) => {
    const res = await fetch("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${omnirouteKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: chosenModel,
        messages,
        temperature: temperature ?? 0.1,
        max_tokens: max_tokens ?? 2500,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`OmniRoute returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  };

  const context = gatherApexContext({
    workspaceRoot: process.cwd(),
    prompt: "",
  });

  for (let idx = 0; idx < fixtures.length; idx++) {
    const f = fixtures[idx];
    console.log(`================================================================================`);
    console.log(`PROMPT ${idx + 1}/${fixtures.length} [ID: ${f.id}]`);
    console.log(`================================================================================`);
    console.log(`Prompt: "${f.prompt}"\n`);
    console.log(`Expected Benchmark Criteria:`);
    console.log(`  isActionable: ${f.expected.isActionable}`);
    console.log(`  minIntents: ${f.expected.minIntents}`);
    console.log(`  layers: [${f.expected.layers.join(", ")}]`);
    if (f.expected.hasImplied) {
      console.log(`  hasImplied: true (must capture unspoken SDLC requirements)`);
    }
    console.log();

    try {
      const res = await expandLedgerWithApex(f.prompt, context, liveDispatch, {
        skipCache: true,
      });
      console.log(
        `--- RAW RETURNED LEDGER (isActionable: ${res.isActionable}, items: ${res.intents.length}) ---`
      );
      console.log(JSON.stringify(res, null, 2));
      console.log();
      console.log(
        `Operator Verdict: [Awaiting manual operator judgment - no automated pass/fail emitted]`
      );
    } catch (err) {
      console.error(`ERROR running prompt ${f.id} against live model:`, err);
    }
    console.log();
  }

  console.log("================================================================================");
  console.log("Live Model Evaluation Run Completed. Ready for Operator Review.");
  console.log("================================================================================\n");
}

runEvaluation().catch(console.error);
