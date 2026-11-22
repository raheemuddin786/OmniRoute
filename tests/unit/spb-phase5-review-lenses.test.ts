import test from "node:test";
import assert from "node:assert/strict";
import { expandLedgerWithApex, gatherApexContext } from "../../open-sse/services/spb/apexLedger.ts";

test("Phase 5: expandLedgerWithApex prompt includes review lenses and strictly qualifies required-implied", async () => {
  let capturedSystemPrompt = "";

  const mockDispatch = async (payload: { messages: Array<{ role: string; content: string }> }) => {
    capturedSystemPrompt = payload.messages.find((m) => m.role === "system")?.content || "";
    return JSON.stringify({
      isActionable: true,
      intents: [
        {
          id: "I1",
          text: "Add login endpoint",
          kind: "explicit",
          promptRef: "Add login endpoint",
          layer: "api",
          targetFiles: ["src/api/login.ts"],
          acceptance: "Endpoint returns 200 with auth token",
        },
        {
          id: "I2",
          text: "Add users table database migration",
          kind: "required-implied",
          parentId: "I1",
          reason: "Login endpoint fails at runtime without users table in database",
          layer: "data",
          targetFiles: ["src/lib/db/migrations/001_users.sql"],
          acceptance: "Database table users exists",
        },
        {
          id: "I3",
          text: "Document login API in docs/api.md",
          kind: "optional",
          layer: "docs",
          targetFiles: ["docs/api.md"],
          acceptance: "Documentation includes POST /login sample",
        },
      ],
      nonGoals: [],
      constraints: [],
    });
  };

  const context = gatherApexContext({
    prompt: "Add login endpoint",
    conversationMessages: [],
  });

  const expansion = await expandLedgerWithApex("Add login endpoint", context, mockDispatch, {
    skipCache: true,
  });

  // Assert review lenses are in the prompt
  assert.match(capturedSystemPrompt, /REVIEW LENSES/i, "Prompt must include REVIEW LENSES section");
  assert.match(capturedSystemPrompt, /QA/i);
  assert.match(capturedSystemPrompt, /Security/i);
  assert.match(capturedSystemPrompt, /DB\/migrations/i);
  assert.match(capturedSystemPrompt, /UX/i);
  assert.match(capturedSystemPrompt, /DevOps/i);
  assert.match(capturedSystemPrompt, /Docs/i);

  // Assert required-implied rule is enforced
  assert.match(
    capturedSystemPrompt,
    /required-implied ONLY if the ask fails or is unsafe without it/i
  );
  assert.match(capturedSystemPrompt, /everything else is optional/i);

  assert.equal(expansion.isActionable, true);
  assert.equal(expansion.intents.length, 3);
  assert.equal(expansion.intents[1].kind, "required-implied");
  assert.equal(expansion.intents[1].parentId, "I1");
  assert.ok(expansion.intents[1].reason);
  assert.equal(expansion.intents[2].kind, "optional");
});
