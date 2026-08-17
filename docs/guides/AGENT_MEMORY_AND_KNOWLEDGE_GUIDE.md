---
title: "Agent Persistent Memory & Knowledge Management Guide"
description: "How AI agents use, store, and automatically update persistent project knowledge, vector memories, and architecture guidelines."
---

# Agent Persistent Memory & Knowledge Management Guide

This document defines how AI agents interacting with OmniRoute use, store, and automatically update persistent project knowledge, vector memories, and architecture guidelines.

---

## 1. Overview & Core Architecture

OmniRoute features a persistent vector and semantic memory engine backed by SQLite (`memories` table) and optional Qdrant vector storage.

```
 User Chat Directive / Learning
   │
   ├──► 1. Save: omniroute_memory_add (type: "factual" | "procedural" | "semantic")
   │       └── Stores facts/rules into SQLite with embeddings & metadata tags.
   │
   └──► 2. Retrieve: omniroute_memory_search (query, limit, maxTokens)
           └── Pulls relevant ~300-token rules in <50ms without re-reading raw 150k files.
```

---

## 2. How to Teach the Agent (Natural Language Examples)

You can instruct the agent in natural English. When the agent recognizes a persistent rule, fact, or constraint, it automatically calls `omniroute_memory_add` and confirms the saved knowledge.

### Example A: Environment & Database Hosting

**User says:**

> _"Remember: our database is hosted on Hostinger. Always check `src/lib/db/migrations/` for schema definitions instead of local assumptions."_

**What the Agent executes:**

```json
{
  "tool": "omniroute_memory_add",
  "arguments": {
    "apiKeyId": "default",
    "type": "factual",
    "key": "database_hosting_and_migrations",
    "content": "Database is hosted on Hostinger. Always verify migrations in src/lib/db/migrations/ before writing SQL or schema changes.",
    "metadata": { "category": "database", "scope": "workspace" }
  }
}
```

### Example B: Security & Credential Rules

**User says:**

> _"Remember: all public upstream credentials must use `resolvePublicCred()` from `open-sse/utils/publicCreds.ts`, never raw string literals."_

**What the Agent executes:**

```json
{
  "tool": "omniroute_memory_add",
  "arguments": {
    "apiKeyId": "default",
    "type": "procedural",
    "key": "security_public_credentials_rule",
    "content": "Public upstream credentials must be embedded via resolvePublicCred() from open-sse/utils/publicCreds.ts - never as string literals.",
    "metadata": { "category": "security", "scope": "global" }
  }
}
```

### Example C: Post-Bug Fix Lessons Learned

**User says:**

> _"Note for future tasks: whenever we modify combo target lists, make sure `targetTimeoutMs` is at least 18000ms to prevent stream cutoff on large turns."_

**What the Agent executes:**

```json
{
  "tool": "omniroute_memory_add",
  "arguments": {
    "apiKeyId": "default",
    "type": "semantic",
    "key": "combos_timeout_guideline",
    "content": "Combos with 1M+ context models should have targetTimeoutMs >= 18000ms to allow multi-token completions to finish without 504 disconnects.",
    "metadata": { "category": "resilience", "scope": "combos" }
  }
}
```

---

## 3. The 4-Step Mandatory Agent Task Checklist

Whenever the agent is asked to implement a feature, refactor code, or fix a bug, it must follow this step-by-step process:

```
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 1: CONTEXT & MEMORY RETRIEVAL                                     │
│ • Call omniroute_memory_search with task keywords                      │
│ • Read relevant project rules from AGENTS.md / .agent/prompts.md       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ STEP 2: NO-ASSUMPTION IMPLEMENTATION PLAN                              │
│ • Inspect active files on disk via local_corpus_read / grep_search     │
│ • Verify exact signatures, paths, and dependencies (no guessing)       │
│ • Formulate plan with 0% mock, 0% fake, 0% dummy code                  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ STEP 3: END-TO-END IMPLEMENTATION                                      │
│ • Apply changes across all affected layers (routes, handlers, DB, UI)  │
│ • Preserve formatting and existing unrelated comments                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ STEP 4: VERIFICATION & AUTO-LEARNING                                   │
│ • Run typechecks / linters (npm run typecheck:core)                    │
│ • If a new pattern or rule was established, call omniroute_memory_add  │
│ • Report completion with exact diffs and verified memory updates       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Multi-Project Workspace Isolation & Git Sync

1. **Workspace Isolation:** Memories tagged with `metadata: { "scope": "workspace" }` and `sessionId` are isolated to the active repository path and will never contaminate other workspaces.
2. **Dynamic Live Git Sync:** Code lookups via `local_corpus_search(refresh: true)` perform incremental live disk rescans. When you switch git branches or pull changes, the agent immediately inspects the active branch without using stale cached code.
3. **Prefix KV Cache Preservation:** Because core rules are retrieved dynamically as small 300-token chunks into prompt context, upstream Gemini and Anthropic models maintain a **99.4% prefix cache hit rate**, eliminating token waste and autocompact thrashing.

---

## 5. MCP Tool Reference for Memory Operations

| Tool Name                 | Scopes Required                    | Parameters                                        | Purpose                                                      |
| ------------------------- | ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `omniroute_memory_search` | `read:memory` (wildcard `*`)       | `apiKeyId`, `query`, `type`, `limit`, `maxTokens` | Search vector memories by semantic query or category.        |
| `omniroute_memory_add`    | `write:memory` (wildcard `*`)      | `apiKeyId`, `type`, `key`, `content`, `metadata`  | Ingest a new persistent rule, fact, or architecture pattern. |
| `omniroute_memory_clear`  | `write:memory` (wildcard `*`)      | `apiKeyId`, `type`, `olderThan`                   | Clean up expired or obsolete memories.                       |
| `local_corpus_search`     | `read:local-corpus` (wildcard `*`) | `query`, `limit`, `refresh`                       | Full-text and semantic search over active repository code.   |
| `local_corpus_read`       | `read:local-corpus` (wildcard `*`) | `relativePath`, `startLine`, `endLine`            | Bounded file reading without loading entire 150k files.      |
