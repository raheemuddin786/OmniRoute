/**
 * Concurrency Test: Multiple Agents executing identical tasks and repetitive operations concurrently.
 * Uses real-world Playwright and Bash tooling declarations.
 */

const BASE_URL = "http://localhost:20128";
const API_KEY = "sk-55c5aca9cc1c57ab-7d1796-a4972334";

const PLAYWRIGHT_AND_BASH_TOOLS = [
  {
    type: "function",
    function: {
      name: "mcp__plugin_playwright_playwright__browser_navigate",
      description: "Navigate to a URL using Playwright browser",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash_command",
      description: "Execute a bash shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "SubagentHandback",
      description: "Deliver final task report and finish agent execution",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Final report" },
        },
        required: ["message"],
      },
    },
  },
];

async function executeAgentTurn({ agentId, turn, messages, sessionId, extraHeaders = {} }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    ...extraHeaders,
  };
  if (sessionId) {
    headers["x-session-id"] = sessionId;
  }

  const payload = {
    model: "auto/claude-haiku",
    messages,
    tools: PLAYWRIGHT_AND_BASH_TOOLS,
    max_tokens: 100,
  };

  const start = Date.now();
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const durationMs = Date.now() - start;
  const status = res.status;
  const bodyText = await res.text();
  let json = null;
  try {
    json = JSON.parse(bodyText);
  } catch {
    /* not json */
  }

  return { agentId, turn, status, durationMs, bodyText, json };
}

async function runScenarioA_WithoutExplicitSessionHeaders() {
  console.log("\n=======================================================");
  console.log("SCENARIO A: Concurrent Agents with Identical Prompts (No explicit x-session-id)");
  console.log("Testing whether session fingerprint collision occurs across concurrent agents...");
  console.log("=======================================================");

  // 3 independent agents executing the same prompt in parallel:
  // "Inspect localhost service using Playwright and Bash"
  const commonSystem = "You are an autonomous operations agent. Inspect local services.";
  const commonUser = "Run Playwright navigation to http://localhost:20128 and run bash uptime.";

  // Each agent executes turn 1 (calling browser_navigate):
  const promises = [1, 2, 3].map((agentNum) => {
    const messages = [
      { role: "system", content: commonSystem },
      { role: "user", content: commonUser },
      {
        role: "assistant",
        tool_calls: [
          {
            id: `call_nav_${agentNum}`,
            type: "function",
            function: {
              name: "mcp__plugin_playwright_playwright__browser_navigate",
              arguments: JSON.stringify({ url: "http://localhost:20128" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: `call_nav_${agentNum}`,
        content: JSON.stringify({ status: 200, title: "OmniRoute Dashboard" }),
      },
    ];

    return executeAgentTurn({
      agentId: `Agent-${agentNum}`,
      turn: 1,
      messages,
    });
  });

  const results = await Promise.all(promises);
  for (const r of results) {
    console.log(`[${r.agentId}] Status: ${r.status} (${r.durationMs}ms)`);
    if (
      r.bodyText.includes("Governance Steering Directive") ||
      r.bodyText.includes("repetitive_loop")
    ) {
      console.log(`  -> ⚠️ GOVERNANCE LOOP TRIGGERED ON ${r.agentId}!`);
      console.log(`  -> Body snippet: ${r.bodyText.slice(0, 300)}`);
    } else {
      console.log(`  -> Response snippet: ${r.bodyText.slice(0, 150)}`);
    }
  }

  return results;
}

async function runScenarioB_SequentialDependentTasks() {
  console.log("\n=======================================================");
  console.log("SCENARIO B: Concurrent Independent Agents + Dependent Synthesizer");
  console.log("=======================================================");

  // Step 1: 3 parallel workers
  console.log("Step 1: Running 3 independent worker agents concurrently...");
  const workerResults = await Promise.all(
    [1, 2, 3].map(async (id) => {
      return executeAgentTurn({
        agentId: `Worker-${id}`,
        turn: 1,
        sessionId: `worker-session-${id}`,
        messages: [
          { role: "system", content: "Worker agent for task inspection." },
          { role: "user", content: `Execute worker check #${id}` },
          {
            role: "assistant",
            tool_calls: [
              {
                id: `call_bash_${id}`,
                type: "function",
                function: {
                  name: "bash_command",
                  arguments: JSON.stringify({ command: `echo "Worker ${id} ready"` }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: `call_bash_${id}`,
            content: `Worker ${id} ready`,
          },
        ],
      });
    })
  );

  for (const w of workerResults) {
    console.log(`Worker-${w.agentId} completed with status: ${w.status}`);
  }

  // Step 2: Dependent Synthesizer Agent (waits for workers)
  console.log("\nStep 2: Running Dependent Synthesizer Agent...");
  const synthResult = await executeAgentTurn({
    agentId: "Synthesizer-Agent",
    turn: 1,
    sessionId: "synthesizer-master-session",
    messages: [
      { role: "system", content: "Synthesize all worker outputs." },
      { role: "user", content: "All 3 workers completed. Deliver SubagentHandback." },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_synth_hb",
            type: "function",
            function: {
              name: "SubagentHandback",
              arguments: JSON.stringify({
                message: "All 3 workers completed inspection successfully.",
              }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_synth_hb",
        content: "Handback accepted.",
      },
    ],
  });

  console.log(`Synthesizer status: ${synthResult.status} (${synthResult.durationMs}ms)`);
  return { workerResults, synthResult };
}

async function main() {
  await runScenarioA_WithoutExplicitSessionHeaders();
  await runScenarioB_SequentialDependentTasks();
}

main().catch(console.error);
