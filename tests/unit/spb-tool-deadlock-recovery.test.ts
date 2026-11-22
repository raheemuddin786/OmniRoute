import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../open-sse/services/spb/intentAnalyzer.ts";
import { detectAndRecoverFromToolDeadlock } from "../../open-sse/services/spb/tieredRegistry.ts";
import { processSmartProxyRouting } from "../../open-sse/services/spb/proxyBridge.ts";

test("SPB Tool Deadlock: classifyIntent extracts tool failure diagnostic details on string mismatch", () => {
  const messages: Array<{ role: string; content?: unknown }> = [
    {
      role: "user",
      content: "Please modify the component",
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_edit_1",
          name: "Edit",
          input: {
            file_path: "src/App.tsx",
            old_string: "const x = 1;",
            new_string: "const x = 2;",
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_edit_1",
          content:
            "<tool_use_error>String to replace not found in file.\nString: const x = 1;</tool_use_error>",
        },
      ],
    },
  ];

  const intent = classifyIntent(messages);
  assert.equal(intent.isToolResultTurn, true);
  assert.equal(intent.isToolExecutionError, true);
  assert.ok(intent.toolFailureDiagnostic);
  assert.equal(intent.toolFailureDiagnostic?.toolName, "Edit");
  assert.equal(intent.toolFailureDiagnostic?.filePath, "src/App.tsx");
  assert.equal(intent.toolFailureDiagnostic?.errorReason, "string_not_found");
});

test("SPB Tool Deadlock: detectAndRecoverFromToolDeadlock triggers after reaching failure threshold", () => {
  const diagnostic = {
    toolName: "Edit",
    filePath: "apps/web/src/App.tsx",
    errorReason: "string_not_found" as const,
    rawErrorSnippet: "String to replace not found in file.",
  };

  // Turn 1 failure: threshold=2 -> not yet deadlocked, counter increments to 1
  const firstTurn = detectAndRecoverFromToolDeadlock(diagnostic, 0, "CODE_GENERATION", 2);
  assert.equal(firstTurn.isDeadlocked, false);
  assert.equal(firstTurn.updatedConsecutiveFailures, 1);

  // Turn 2 failure: threshold=2 reached -> deadlock detected with prescriptive guidance
  const secondTurn = detectAndRecoverFromToolDeadlock(diagnostic, 1, "CODE_GENERATION", 2);
  assert.equal(secondTurn.isDeadlocked, true);
  assert.equal(secondTurn.updatedConsecutiveFailures, 2);
  assert.ok(secondTurn.correctiveDirective?.includes("REPEATED TOOL FAILURE DEADLOCK DETECTED"));
  assert.ok(
    secondTurn.correctiveDirective?.includes(
      "The string you specified as target/old_string does NOT match"
    )
  );
  assert.ok(secondTurn.correctiveDirective?.includes("Call Read/View on the exact line range"));
  assert.ok(secondTurn.correctiveDirective?.includes("Write tool or bash sed/awk/node script"));
});

test("SPB Tool Deadlock: detectAndRecoverFromToolDeadlock resets on successful tool execution", () => {
  // Successful turn has no diagnostic -> resets counter to 0
  const successTurn = detectAndRecoverFromToolDeadlock(undefined, 3, "CODE_GENERATION", 2);
  assert.equal(successTurn.isDeadlocked, false);
  assert.equal(successTurn.updatedConsecutiveFailures, 0);
});

test("SPB Tool Deadlock: provides specific guidance for tool_not_available and multiple_matches", () => {
  const notAvailDiag = {
    toolName: "Execute",
    errorReason: "tool_not_available" as const,
    rawErrorSnippet: "<tool_use_error>Error: No such tool available: Execute</tool_use_error>",
  };
  const resNotAvail = detectAndRecoverFromToolDeadlock(notAvailDiag, 1, "CODE_GENERATION", 2);
  assert.ok(resNotAvail.isDeadlocked);
  assert.ok(
    resNotAvail.correctiveDirective?.includes(
      'The tool "Execute" is not available in this environment'
    )
  );
  assert.ok(resNotAvail.correctiveDirective?.includes("Use standard shell commands via Bash"));

  const multiMatchesDiag = {
    toolName: "Edit",
    errorReason: "multiple_matches" as const,
    rawErrorSnippet: "Found 2 matches of the string to replace, but replace_all is false.",
  };
  const resMulti = detectAndRecoverFromToolDeadlock(multiMatchesDiag, 1, "CODE_GENERATION", 2);
  assert.ok(resMulti.isDeadlocked);
  assert.ok(resMulti.correctiveDirective?.includes("appears multiple times in the file"));
  assert.ok(resMulti.correctiveDirective?.includes("set replace_all: true"));
});

test("SPB Tool Deadlock: processSmartProxyRouting injects corrective directive into messages on deadlock", async () => {
  const sessionId = "deadlock-test-" + Date.now();

  const messages1: Array<{ role: string; content?: unknown }> = [
    { role: "user", content: "Update the code" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "c1",
          name: "Edit",
          input: { file_path: "src/App.tsx", old_string: "old", new_string: "new" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c1",
          content: "<tool_use_error>String to replace not found in file.</tool_use_error>",
        },
      ],
    },
  ];

  // Turn 1: failure recorded
  await processSmartProxyRouting({ sessionId, messages: messages1 });

  // Turn 2: second failure on same session
  const messages2: Array<{ role: string; content?: unknown }> = [
    ...messages1,
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "c2",
          name: "Edit",
          input: { file_path: "src/App.tsx", old_string: "old", new_string: "new" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "c2",
          content: "<tool_use_error>String to replace not found in file.</tool_use_error>",
        },
      ],
    },
  ];

  const res2 = await processSmartProxyRouting({ sessionId, messages: messages2 });
  assert.ok(res2);

  // Verify that corrective guidance directive was injected in res2.enhancedMessages
  const enhanced = res2.enhancedMessages || messages2;
  const lastMsg = enhanced[enhanced.length - 1];
  const lastContent = JSON.stringify(lastMsg.content);
  assert.ok(lastContent.includes("REPEATED TOOL FAILURE DEADLOCK DETECTED"));
  assert.ok(lastContent.includes("The string you specified as target/old_string does NOT match"));
});
