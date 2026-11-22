/**
 * Reproduction & Diagnosis of Governance Issue Under Concurrent Execution:
 * Parallel agents executing Playwright and Bash operations with identical initial task prompts.
 */

import { resolveGovernanceIdentity } from "../../open-sse/governance/identity.ts";
import { LoopBreaker } from "../../open-sse/governance/loopBreaker.ts";

console.log("=== Reproducing Concurrent Governance Session Collisions ===\n");

// Agent 1: Autonomous Web Researcher (Playwright)
const agent1Turn1 = {
  model: "antigravity/gemini-3-flash",
  messages: [
    { role: "system", content: "You are an autonomous operations agent." },
    { role: "user", content: "Run diagnostic checks on local infrastructure." },
  ],
};

// Agent 2: Autonomous System Auditor (Bash)
const agent2Turn1 = {
  model: "antigravity/gemini-3-flash",
  messages: [
    { role: "system", content: "You are an autonomous operations agent." },
    { role: "user", content: "Run diagnostic checks on local infrastructure." },
  ],
};

const id1 = resolveGovernanceIdentity({ body: agent1Turn1 });
const id2 = resolveGovernanceIdentity({ body: agent2Turn1 });

console.log(`Agent 1 Session ID: ${id1.sessionId} (source: ${id1.source})`);
console.log(`Agent 2 Session ID: ${id2.sessionId} (source: ${id2.source})`);
console.log(`Session Collision: ${id1.sessionId === id2.sessionId ? "YES (COLLIDED!)" : "NO"}\n`);

// Now simulate concurrent tool execution in LoopBreaker with this collided session ID
const breaker = new LoopBreaker();
const sessionId = id1.sessionId;

console.log("Simulating concurrent execution in the shared loop breaker window:");
console.log("Agent 1 executes Playwright navigation...");
let d1 = breaker.observe(sessionId, "mcp__plugin_playwright_playwright__browser_navigate", {
  url: "http://localhost:20128",
});
console.log("  -> Agent 1 Call 1 detection:", d1);

console.log("Agent 2 executes Bash command...");
let d2 = breaker.observe(sessionId, "bash_command", { command: "uptime" });
console.log("  -> Agent 2 Call 1 detection:", d2);

console.log("Agent 1 executes Playwright navigation (Turn 2)...");
let d3 = breaker.observe(sessionId, "mcp__plugin_playwright_playwright__browser_navigate", {
  url: "http://localhost:20128",
});
console.log("  -> Agent 1 Call 2 detection:", d3);

console.log("Agent 2 executes Bash command (Turn 2)...");
let d4 = breaker.observe(sessionId, "bash_command", { command: "uptime" });
console.log("  -> Agent 2 Call 2 detection:", d4);

console.log("Agent 1 executes Playwright navigation (Turn 3)...");
let d5 = breaker.observe(sessionId, "mcp__plugin_playwright_playwright__browser_navigate", {
  url: "http://localhost:20128",
});
console.log("  -> Agent 1 Call 3 detection:", d5);

console.log("Agent 2 executes Bash command (Turn 3)...");
let d6 = breaker.observe(sessionId, "bash_command", { command: "uptime" });
console.log("  -> Agent 2 Call 3 detection:", d6);

if (d5 || d6) {
  console.log("\n🚨 CRITICAL GOVERNANCE FAILURE CONFIRMED:");
  console.log("LoopBreaker tripped a FALSE POSITIVE loop on independent parallel agents!");
  console.log("Tripped detection:", d5 || d6);
}
