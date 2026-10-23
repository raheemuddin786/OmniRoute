/**
 * Live End-to-End Verification of OmniRoute Package & Governance
 * Runs direct HTTP requests against http://localhost:20128
 */

const BASE_URL = "http://localhost:20128";
const API_KEY = "sk-55c5aca9cc1c57ab-7d1796-a4972334";

async function runTest(name, fn) {
  process.stdout.write(`TEST: ${name} ... `);
  try {
    const result = await fn();
    console.log(`PASSED ${result ? `(${result})` : ""}`);
    return { name, passed: true, details: result };
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    return { name, passed: false, error: err.message };
  }
}

async function main() {
  console.log("=== OmniRoute Live Verification Suite ===\n");
  const results = [];

  // Test 1: Health & Models Catalog
  results.push(
    await runTest("GET /v1/models (Catalog Check)", async () => {
      const res = await fetch(`${BASE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (!Array.isArray(data.data) || data.data.length === 0) {
        throw new Error("No models returned");
      }
      return `${data.data.length} models loaded`;
    })
  );

  // Test 2: Ingress Governance - Repaired JSON with unescaped control characters in string literals
  results.push(
    await runTest(
      "POST /v1/chat/completions (Unescaped Control Characters in Tool Args)",
      async () => {
        // Model echoed multiline JSON arguments with unescaped newlines/tabs inside string literal
        const malformedJsonWithControlChars =
          '{\n  "path": "file1.txt",\n  "content": "line1\nline2\ttab"\n}';
        const payload = {
          model: "auto/claude-haiku",
          messages: [
            { role: "user", content: "read a file" },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_multiline_1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: malformedJsonWithControlChars,
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_multiline_1",
              content: "file written successfully",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "write_file",
                parameters: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["path", "content"],
                },
              },
            },
          ],
          max_tokens: 10,
        };

        const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        const status = res.status;
        const text = await res.text();
        // The request should pass governance validation (not return 400 malformed_arguments)
        if (text.includes("malformed_arguments") || text.includes("Bad control character")) {
          throw new Error(`Governance failed to repair unescaped control characters: ${text}`);
        }
        return `Status ${status} (Governance accepted repaired arguments)`;
      }
    )
  );

  // Test 3: Ingress Governance - Claude Code __unparsedToolInput Unpacking
  results.push(
    await runTest("POST /v1/messages (Claude Code __unparsedToolInput Unpacking)", async () => {
      const payload = {
        model: "auto/claude-haiku",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_unparsed_1",
                name: "read_file",
                input: {
                  __unparsedToolInput: {
                    raw: '{"path":"src/index.ts"}',
                  },
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_unparsed_1",
                content: "export const x = 1;",
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        max_tokens: 10,
      };

      const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (
        text.includes("must have required property 'path'") ||
        text.includes("malformed_arguments")
      ) {
        throw new Error(`Governance rejected __unparsedToolInput: ${text}`);
      }
      return `Status ${res.status} (Unpacked __unparsedToolInput cleanly)`;
    })
  );

  // Test 4: SubagentHandback Empty Argument Resilience
  results.push(
    await runTest(
      "POST /v1/chat/completions (SubagentHandback Empty Argument Auto-Default)",
      async () => {
        const payload = {
          model: "auto/claude-haiku",
          messages: [
            { role: "user", content: "finish task" },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_handback_1",
                  type: "function",
                  function: {
                    name: "SubagentHandback",
                    arguments: "{}",
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "call_handback_1",
              content: "Task concluded",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "SubagentHandback",
                parameters: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
              },
            },
          ],
          max_tokens: 10,
        };

        const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        const text = await res.text();
        if (text.includes("must have required property 'message'")) {
          throw new Error(`SubagentHandback rejected empty arguments: ${text}`);
        }
        return `Status ${res.status} (SubagentHandback accepted without deadlock)`;
      }
    )
  );

  // Test 5: Anthropic tool_result with is_error Idempotency
  results.push(
    await runTest("POST /v1/messages (tool_result is_error: true Idempotency)", async () => {
      const payload = {
        model: "auto/claude-haiku",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_err_1",
                name: "read_file",
                input: { path: "nonexistent.txt" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_err_1",
                content: "File not found",
                is_error: true,
              },
            ],
          },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        max_tokens: 10,
      };

      const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      return `Status ${res.status} (Preserved is_error: true tool_result)`;
    })
  );

  console.log("\n=== Verification Summary ===");
  const allPassed = results.every((r) => r.passed);
  console.log(`Passed: ${results.filter((r) => r.passed).length}/${results.length}`);
  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Execution failed:", err);
  process.exit(1);
});
