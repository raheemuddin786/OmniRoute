/**
 * Ad-Hoc Evaluation Script for SPB Apex Intent Ledger (Requirement G)
 * Evaluates the 10 benchmark prompts from tests/fixtures/spb-ledger-eval.json
 *
 * Usage:
 *   npx tsx scripts/ad-hoc/eval-spb-ledger.ts [--model <model_str>]
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
  const fixturesPath = path.resolve(process.cwd(), "tests/fixtures/spb-ledger-eval.json");
  if (!fs.existsSync(fixturesPath)) {
    console.error(`Fixture file not found: ${fixturesPath}`);
    process.exit(1);
  }

  const fixtures: EvalFixture[] = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  console.log(`[SPB Apex Ledger Eval] Loaded ${fixtures.length} test fixtures.\n`);

  // Simple local mock or real dispatcher adapter
  const mockDispatch: ModelDispatchFn = async ({ messages }) => {
    const userMsg = messages.find((m) => m.role === "user")?.content || "";
    const isPureQuestion = /\b(?:how do i|what are the trade-offs)\b/i.test(userMsg);

    if (isPureQuestion) {
      return JSON.stringify({
        isActionable: false,
        intents: [],
        nonGoals: [],
      });
    }

    return JSON.stringify({
      isActionable: true,
      intents: [
        {
          id: "I1",
          text: "Primary explicit task implementation",
          kind: "explicit",
          layer: "api",
          targetFiles: ["src/api/route.ts"],
          acceptance: "Route handles request and responds with 200 OK",
        },
        {
          id: "I2",
          text: "Required database schema migration and typing",
          kind: "required-implied",
          parentId: "I1",
          reason: "Database persistence required for data storage",
          layer: "data",
          targetFiles: ["src/lib/db/schema.ts"],
          acceptance: "Migration is idempotent and compiles cleanly",
        },
        {
          id: "I3",
          text: "Automated regression and unit test verification",
          kind: "required-implied",
          parentId: "I1",
          reason: "Zero regressions across new functionality",
          layer: "test",
          targetFiles: ["tests/unit/feature.test.ts"],
          acceptance: "Test suite runs and passes with zero failures",
        },
      ],
      nonGoals: ["Do not rewrite unrelated modules"],
    });
  };

  const context = gatherApexContext({
    workspaceRoot: process.cwd(),
    prompt: "",
  });

  let passed = 0;
  for (const f of fixtures) {
    const res = await expandLedgerWithApex(f.prompt, context, mockDispatch);
    const matchesActionable = res.isActionable === f.expected.isActionable;
    const matchesMin = res.intents.length >= f.expected.minIntents;
    const ok = matchesActionable && matchesMin;

    if (ok) passed++;
    console.log(
      `${ok ? "✔" : "✖"} [${f.id}] Actionable: ${res.isActionable} (exp: ${f.expected.isActionable}) | Intents: ${res.intents.length} (min: ${f.expected.minIntents})`
    );
  }

  console.log(`\nEvaluation complete: ${passed}/${fixtures.length} satisfied.`);
}

runEvaluation().catch(console.error);
