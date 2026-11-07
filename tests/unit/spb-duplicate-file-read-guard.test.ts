import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../../open-sse/services/spb/intentAnalyzer.ts";

test("SPB Duplicate File Read Guard: flags duplicate read on 3rd inspection and forces CODE_GENERATION", () => {
  const filePath = "/src/components/Header.tsx";

  // Build a conversation with 3 Read tool calls on the same file without intermediate write
  const messages = [
    { role: "user", content: "Let's work on the codebase." },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "export default function Header() {}" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "export default function Header() {}" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "export default function Header() {}" }],
    },
  ];

  const intent = classifyIntent(messages);

  assert.equal(intent.isDuplicateFileRead, true, "Should flag isDuplicateFileRead as true");
  assert.equal(intent.duplicateFilePath, filePath, "Should identify the duplicate file path");
  assert.equal(
    intent.taskPhase,
    "CODE_GENERATION",
    "Should force taskPhase to CODE_GENERATION to break read loop"
  );
});

test("SPB Duplicate File Read Guard: resets file read count when code mutation tool is used", () => {
  const filePath = "/src/components/Header.tsx";

  // Conversation with 2 reads, then an Edit, then 1 read (should NOT trigger duplicate guard)
  const messages = [
    { role: "user", content: "Refactor Header." },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "line 1" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "line 1" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: { file_path: filePath, old_string: "line 1", new_string: "line 1 modified" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "applied" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", name: "Read", input: { file_path: filePath } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", content: "line 1 modified" }],
    },
  ];

  const intent = classifyIntent(messages);

  assert.equal(
    intent.isDuplicateFileRead,
    false,
    "Should NOT flag duplicate read because mutation tool intervened"
  );
});
