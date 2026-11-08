/**
 * Production-Grade Multi-Agent Concurrency & Governance Evaluation
 *
 * Tests concurrent agents running in parallel to execute identical tasks and repetitive operations:
 * - Independent tasks executed concurrently across parallel agents
 * - Repetitive loop simulation under concurrent load to verify governance isolation
 * - Dependent task sequencing (synthesizer agent)
 * - Real-world tooling: Playwright browser navigation, Bash execution, and SubagentHandback
 */

const BASE_URL = "http://localhost:20128";
const API_KEY = "sk-55c5aca9cc1c57ab-7d1796-a4972334";
const MODEL = "antigravity/gemini-3-flash";

const TOOLS = [
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

async function callChat(messages, sessionId, stream = false) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (sessionId) {
    headers["x-session-id"] = sessionId;
  }

  const payload = {
    model: MODEL,
    messages,
    tools: TOOLS,
    max_tokens: 150,
    stream,
  };

  const start = Date.now();
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const durationMs = Date.now() - start;
  const status = res.status;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* sse or text */
  }

  return { status, durationMs, text, json };
}

async function runTest() {
  console.log("================================================================================");
  console.log("  MULTI-AGENT CONCURRENCY & GOVERNANCE EVALUATION");
  console.log("================================================================================\n");

  // PHASE 1: Independent Concurrent Agents (Healthy, No Loops)
  console.log("[Phase 1] Launching 3 independent agents concurrently in parallel...");
  const agent1Promise = (async () => {
    console.log("  -> [Agent-Alpha] Step 1: Navigating to service endpoint via Playwright...");
    const res1 = await callChat(
      [
        { role: "system", content: "You are Agent Alpha. Inspect service web UI." },
        { role: "user", content: "Navigate to http://localhost:20128 and inspect dashboard." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_alpha_1",
              type: "function",
              function: {
                name: "mcp__plugin_playwright_playwright__browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:20128/dashboard" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_alpha_1",
          content: JSON.stringify({ status: 200, title: "OmniRoute Dashboard", dom_ready: true }),
        },
      ],
      "session-agent-alpha"
    );

    console.log(`  -> [Agent-Alpha] Completed turn (Status: ${res1.status}, ${res1.durationMs}ms)`);
    return { agent: "Agent-Alpha", res: res1 };
  })();

  const agent2Promise = (async () => {
    console.log("  -> [Agent-Beta] Step 1: Running bash service health check...");
    const res2 = await callChat(
      [
        { role: "system", content: "You are Agent Beta. Run shell diagnostic commands." },
        { role: "user", content: "Run bash uptime and check node memory usage." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_beta_1",
              type: "function",
              function: {
                name: "bash_command",
                arguments: JSON.stringify({ command: "uptime && vm_stat | head -n 3" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_beta_1",
          content: "load averages: 1.82 1.95 2.01\nMach Virtual Memory Statistics:",
        },
      ],
      "session-agent-beta"
    );

    console.log(`  -> [Agent-Beta] Completed turn (Status: ${res2.status}, ${res2.durationMs}ms)`);
    return { agent: "Agent-Beta", res: res2 };
  })();

  const agent3Promise = (async () => {
    console.log("  -> [Agent-Gamma] Step 1: Querying models catalog via Playwright...");
    const res3 = await callChat(
      [
        { role: "system", content: "You are Agent Gamma. Verify API catalog UI." },
        { role: "user", content: "Check model list UI page." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_gamma_1",
              type: "function",
              function: {
                name: "mcp__plugin_playwright_playwright__browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:20128/v1/models" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_gamma_1",
          content: JSON.stringify({ status: 200, model_count: 6682 }),
        },
      ],
      "session-agent-gamma"
    );

    console.log(`  -> [Agent-Gamma] Completed turn (Status: ${res3.status}, ${res3.durationMs}ms)`);
    return { agent: "Agent-Gamma", res: res3 };
  })();

  const phase1Results = await Promise.all([agent1Promise, agent2Promise, agent3Promise]);
  console.log("\n[Phase 1 Results]: All 3 concurrent agents executed simultaneously.");
  for (const r of phase1Results) {
    console.log(`  * ${r.agent}: Status ${r.res.status} | OK: ${r.res.status === 200}`);
  }

  // PHASE 2: Concurrent Execution with an Active Looping Agent
  console.log(
    "\n[Phase 2] Simulating Concurrent Execution where ONE agent enters a repetitive loop..."
  );
  console.log("  -> Agent-Looping will emit 3 identical browser navigation tool calls.");
  console.log("  -> Concurrently, Agent-Healthy will emit valid, non-looping bash commands.");

  const loopingAgentPromise = (async () => {
    // 3 identical calls to browser_navigate with exact same URL
    const res = await callChat(
      [
        { role: "system", content: "You are a browser crawler agent." },
        { role: "user", content: "Crawl documentation." },
        // Turn 1
        {
          role: "assistant",
          tool_calls: [
            {
              id: "loop_call_1",
              type: "function",
              function: {
                name: "mcp__plugin_playwright_playwright__browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:20128/docs/architecture" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "loop_call_1", content: "Page loaded" },
        // Turn 2: identical
        {
          role: "assistant",
          tool_calls: [
            {
              id: "loop_call_2",
              type: "function",
              function: {
                name: "mcp__plugin_playwright_playwright__browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:20128/docs/architecture" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "loop_call_2", content: "Page loaded" },
        // Turn 3: identical (3rd repeat trips loop breaker!)
        {
          role: "assistant",
          tool_calls: [
            {
              id: "loop_call_3",
              type: "function",
              function: {
                name: "mcp__plugin_playwright_playwright__browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:20128/docs/architecture" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "loop_call_3", content: "Page loaded" },
      ],
      "session-looping-crawler",
      true
    ); // Streamed request to verify in-stream governance transform

    return { agent: "Agent-Looping", res };
  })();

  const healthyAgentPromise = (async () => {
    const res = await callChat(
      [
        { role: "system", content: "You are an audit agent running shell tasks." },
        { role: "user", content: "Check system processes." },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "healthy_call_1",
              type: "function",
              function: {
                name: "bash_command",
                arguments: JSON.stringify({ command: "ps aux | grep node | wc -l" }),
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "healthy_call_1", content: "4" },
      ],
      "session-healthy-audit",
      true
    );

    return { agent: "Agent-Healthy", res };
  })();

  const [loopResult, healthyResult] = await Promise.all([loopingAgentPromise, healthyAgentPromise]);
  console.log("\n[Phase 2 Results]:");
  console.log(`  * Agent-Healthy: Status ${healthyResult.res.status}`);
  console.log(`  * Agent-Looping: Status ${loopResult.res.status}`);

  // Check if looping agent received governance steering directive or loop intervention
  const isLoopDetected =
    loopResult.res.text.includes("Governance Steering Directive") ||
    loopResult.res.text.includes("repetitive loop was detected") ||
    loopResult.res.text.includes("Halting repetitive execution");

  console.log(`  * Agent-Looping received steering directive: ${isLoopDetected}`);

  // PHASE 3: Dependent Task Sequencing (Synthesizer Agent)
  console.log("\n[Phase 3] Sequencing Dependent Task: Synthesizer Agent...");
  const synthRes = await callChat(
    [
      {
        role: "system",
        content: "You are the Coordinator Synthesizer. Consolidate results from all agents.",
      },
      {
        role: "user",
        content:
          "Agents Alpha, Beta, and Gamma completed their tasks. Synthesize and deliver SubagentHandback.",
      },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "synth_final_call",
            type: "function",
            function: {
              name: "SubagentHandback",
              arguments: JSON.stringify({
                message:
                  "All 3 parallel tasks completed successfully: UI checked, OS metrics verified, API catalog confirmed (6682 models).",
              }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "synth_final_call", content: "Synthesis accepted." },
    ],
    "session-synthesizer-coordinator"
  );

  console.log(`  * Synthesizer Agent Turn Status: ${synthRes.status} (${synthRes.durationMs}ms)`);
  if (synthRes.json?.choices?.[0]?.message?.content) {
    console.log(`  * Synthesizer Output: "${synthRes.json.choices[0].message.content.trim()}"`);
  }

  console.log("\n================================================================================");
  console.log("  EVALUATION SUMMARY");
  console.log("================================================================================");
  console.log(
    `  - Phase 1 (Concurrent Parallel Execution): ${phase1Results.every((r) => r.res.status === 200) ? "SUCCESS" : "FAIL"}`
  );
  console.log(
    `  - Phase 2 (Loop Breaker Isolation Under Concurrency): ${healthyResult.res.status === 200 ? "SUCCESS" : "FAIL"}`
  );
  console.log(
    `  - Phase 3 (Dependent Task Sequencing): ${synthRes.status === 200 ? "SUCCESS" : "FAIL"}`
  );
}

runTest().catch(console.error);
