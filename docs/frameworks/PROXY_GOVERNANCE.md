---
title: "Proxy Governance Layer"
version: 3.8.53
lastUpdated: 2026-10-20
---

# Proxy Governance Layer

> **Source of truth:** `open-sse/governance/` and `open-sse/handlers/chatCore/governanceIngress.ts`
> **Last updated:** 2026-10-20 — v3.8.53

The proxy governance layer sits between a client and the upstream model provider and enforces four
things on the model's behalf:

1. **Tool-call schema validation** — a tool call that violates the request's own tool catalog is
   rejected, and the model is told so.
2. **Loop breaking** — a model that repeats the same action, or ping-pongs between two actions, is
   interrupted with a synthetic directive; a persistent loop is aborted.
3. **Reasoning-token bounding** — a stream whose reasoning budget is exhausted is terminated with a
   clean terminal frame instead of running unbounded.
4. **Auditing** — every governance decision is recorded in a content-free audit ring buffer.

The layer is **enforcing**: the loop breaker intervenes, the schema validator rejects, and the token
sentinel truncates. There is no shadow-mode holding period.

---

## The one architectural constraint that shapes everything

**A response stream carries tool CALLS (the model asking), never tool RESULTS (the client
answering).**

This means a rejected tool call **cannot** be delivered by editing the response stream. If the proxy
rewrote the outgoing tool call, the client would still execute it and the model would receive
whatever the client produced. The proxy's only lever is the **next turn's request**: the client
echoes the assistant turn (with the model's tool calls) plus the tool results back to the proxy, and
the proxy replaces the result of a rejected call with a synthetic error result.

The same holds for a loop intervention: it is a synthetic **system** message injected into the next
request, not something appended to the response.

```
turn N   egress ──▶ model streams a tool call ──▶ tap validates it
                         │
                         ├─ rejected ──▶ recorded in the ledger, audited ONCE
                         │                 (the client still sees the call — the proxy
                         │                  cannot un-send it)
                         ▼
turn N+1 ingress ──▶ client echoes the assistant turn + the tool result
                         │
                         └─▶ the proxy REPLACES the rejected call's result
                             with a synthetic error result ──▶ model reads the rejection
```

---

## Modules

| Module                | Location                                          | Responsibility                                                          |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Audit bus             | `open-sse/governance/auditBus.ts`                 | Content-free SHA-256 ring buffer of governance decisions                |
| Identity              | `open-sse/governance/identity.ts`                 | Resolves the session key + principal from the EXISTING id scheme        |
| Token sentinel        | `open-sse/governance/tokenSentinel.ts`            | Reasoning-token ceiling + velocity accounting                           |
| Loop breaker          | `open-sse/governance/loopBreaker.ts`              | Repeat / ping-pong detection over a sliding window                      |
| Loop intervention     | `open-sse/governance/loopIntervention.ts`         | Parks an intervention for the next turn; format-aware injection         |
| Tool-call assembler   | `open-sse/governance/toolCallAssembler.ts`        | Reassembles a streamed tool call into a COMPLETE call                   |
| Tool-schema validator | `open-sse/governance/toolSchemaValidator.ts`      | Validates a complete call against the request's own catalog             |
| Rejection ledger      | `open-sse/governance/toolRejectionLedger.ts`      | Shared state between the egress detection and the ingress enforcement   |
| Rejection enforcer    | `open-sse/governance/toolRejectionEnforcer.ts`    | Rewrites the rejected call's result in the request format's error shape |
| Egress transform      | `open-sse/governance/governanceTransform.ts`      | The client-facing byte tap                                              |
| Ingress               | `open-sse/handlers/chatCore/governanceIngress.ts` | The request-side half: intervention + rejection enforcement             |

---

## Where the layer is wired

### Egress (the tap)

`open-sse/handlers/chatCore/streamingPipeline.ts` inserts the transform into the streaming chain
through `StreamingPipelineDeps`, exactly like every other transform in that chain:

```ts
if (args.governance) {
  piiStream = piiStream.pipeThrough(deps.createGovernanceTransform(args.governance));
}
```

The options are assembled in `open-sse/handlers/chatCore/streamingTail.ts`, which also owns the
per-stream `TokenSentinelTracker` and releases it on `streamController.signal` abort — so a client
disconnect cannot leak a tracker.

Internally the tap is a `GovernanceEgressTap` class rather than one long closure. The tap carries
three independent policies (token sentinel, tool validation, loop breaking), and one function would
hide them behind each other; splitting them into small methods keeps each policy individually
readable and keeps the per-function complexity inside the repo's ratchet budget.

### Ingress (the enforcement)

`open-sse/handlers/chatCore.ts` applies the ingress to the **client-format** body, right after
`sanitizeChatRequestBody` and **before** the request is translated to the upstream wire format:

```ts
const governanceIdentity = resolveGovernanceRequestIdentity(
  {
    body,
    headers: clientRawRequest?.headers,
    provider,
    connectionId: getCurrentConnectionId(),
    fallback: skillRequestId,
  },
  apiKeyInfo
);
const governanceTurnIndex = nextGovernanceTurnIndex(governanceIdentity.sessionId);
body = applyGovernanceIngress({
  body,
  sessionId: governanceIdentity.sessionId,
  sourceFormat,
  principalId: governanceIdentity.principalId,
  requestId: traceId,
  model,
  provider,
  turnIndex: governanceTurnIndex,
  promptHash: hashPromptMessages(body),
});
```

Running the ingress on the client-format body means the repo's existing request translators carry
the governance artifacts into whatever the upstream format is — no new per-format translation path.

The session key is resolved **before** the injection, so injecting the intervention does not change
the key the next turn resolves. If it did, the loop breaker's window would reset every turn.

### The governance session key excludes the tool catalog

The governance session key is the repo's existing conversation fingerprint
(`generateSessionId()` from `open-sse/services/sessionManager.ts`) computed over the request body
**without** its `tools` / `functions` field.

That exclusion is deliberate. The governance layer spans turns — a tool call is rejected on the
egress of turn N and enforced on the ingress of turn N+1, and a loop intervention is parked on turn N
and injected on turn N+1 — so both halves must land on the same key. A client may legitimately send a
different tool set on a later turn (many clients declare the tools only on the first turn), and if
the fingerprint tracked the tool list the key would change and the turn-N+1 enforcement would look
for the rejection under a key that turn N never wrote.

Everything else the fingerprint uses — the model, the provider, the system prompt, the first user
message and the connection id — is stable across the turns of one conversation, and still separates
one conversation from another. See `open-sse/governance/identity.ts`.

---

## The three client wire formats

The layer handles the three formats the chatCore streaming path emits. They differ in how a tool
call is fragmented and in how it is completed:

| Format             | Name arrives in                       | Arguments arrive in                        | Terminal marker                         |
| ------------------ | ------------------------------------- | ------------------------------------------ | --------------------------------------- |
| OpenAI Chat        | `delta.tool_calls[].function.name`    | `delta.tool_calls[].function.arguments`    | the chunk whose `finish_reason` is set  |
| Anthropic Messages | `content_block_start` (`tool_use`)    | `content_block_delta` (`input_json_delta`) | `content_block_stop`                    |
| OpenAI Responses   | `response.output_item.added` (`item`) | `response.function_call_arguments.delta`   | `response.function_call_arguments.done` |

### The terminal marker is the ONLY completion signal

"The accumulated arguments happen to parse as JSON" is **not** a completion signal: `{}` is a
complete JSON document, so a partial argument stream that happens to begin with `{}` would be
evaluated against a PARTIAL argument set — and a call that is actually valid could be rejected.

`ToolCallAssembler` therefore completes a call only on the format's own terminal marker.

### The SSE parser is block-based

An SSE frame is a **block** of lines terminated by a blank line. The Anthropic Messages format
emits two-line frames (`event: <name>` then `data: {...}`), so a line-oriented parser that only
inspects whole lines never finds a line starting with `data:` and the entire Anthropic tool-call
stream escapes governance. `governanceTransform.ts` splits the buffer on the frame separator and
only then looks for the `data:` line _inside_ the frame.

---

## Tool-call rejection

### The catalog

The catalog comes from the **request's own** `tools[]`, through the repo's existing helpers:

- `extractToolSchemaMap(body)` (`open-sse/translator/response/openai-responses/toolSchemas.ts`) — the
  JSON Schemas, normalized across both request shapes.
- `collectDeclaredToolNames(body)` (`open-sse/translator/response/openai-responses/declaredToolName.ts`)
  — the declared tool names.

### Catalog unavailable → SKIP (never reject)

When the catalog is unavailable (no `tools[]`, MCP not connected, …) validation is **skipped** and a
`tool_validation.degraded` event is logged **once per session** — a per-request log would flood the
log on every turn of every tool-less session.

### JSON-Schema subset

The repo already depends on `ajv` and already uses it for tool-argument validation in
`open-sse/translator/deepseekWebToolBinding.ts`. The governance layer reuses ajv (draft 2020-12)
rather than hand-rolling a subset — no new npm dependency. Compiled validators are cached per
schema object. A schema ajv cannot compile is treated as "no usable schema" → the arguments are not
validated (fail OPEN on the schema, not on the call).

### Rejection shapes

The synthetic tool result reuses the shapes the repo's own request translators already build — no
new per-provider format is invented:

| Format             | Shape                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| OpenAI Chat        | `role:"tool"` message whose content becomes `[tool_error: true]\n<message>` |
| Anthropic Messages | `tool_result` block becomes `{content: <message>, is_error: true}`          |
| OpenAI Responses   | `function_call_output.output` becomes `JSON.stringify({error: <message>})`  |

The OpenAI tool role has no `is_error` field — strict upstreams reject unknown message fields — so
the marker is used instead, exactly as `open-sse/translator/request/claude-to-openai.ts` does.

The error text is produced through `sanitizeErrorMessage()` (`open-sse/utils/error.ts`), so a raw
`err.message` / `err.stack` can never reach the client.

### Audit-once

A rejected call is normally seen **twice**: once on the egress (when the model streamed it) and once
on the ingress of the next turn (when the client echoed it back). The assistant turn stays in the
client's history, so every subsequent turn re-presents it. `ToolRejectionLedger` decides which
sighting writes the audit row, so a call that stays in the client's history produces exactly ONE
audit row.

### Session-scoped ledger keys

The ledger is keyed by `sessionId` + `callId` (see `buildRejectionKey()`), NOT by the bare provider
call id. A provider call id is unique only **within one conversation** — providers, SDKs and test
harnesses routinely reuse short, predictable ids like `call_1` or `call_validation`. An unscoped key
therefore lets one conversation's rejection leak into an unrelated conversation: the ingress then
rewrites a tool result the client legitimately produced, replacing real output with a synthetic
error and silently corrupting the model's context.

This is not theoretical. The model-validation proof harness
(`tests/unit/model-validation-service.test.ts`) reuses the call id `call_validation` for every proof
it runs; a proof whose nonce is deliberately wrong records a rejection under that id, and the next
proof — a different conversation with a valid nonce — then found its legitimate tool result
rewritten and failed with `MODEL_VALIDATION_PROOF_FAILED`.

A caller with no session id falls back to the bare call id, which preserves the historical behaviour
for callers that genuinely have no conversation context.

---

## Loop breaking

`LoopBreaker` keeps a bounded sliding window of tool-call **fingerprints** per session — a SHA-256
digest of the tool name and the canonicalized arguments, never the arguments themselves.

- **repeat** — the same fingerprint appears at least `REPEAT_THRESHOLD` (3) times in the window.
- **pingpong** — the window's longest strictly-alternating suffix over exactly two fingerprints
  carries at least `PINGPONG_THRESHOLD` (3) transitions.

Ping-pong is checked FIRST because it is the more specific signal: a ping-pong `A,B,A,B,A` also
contains A three times, so a repeat-first order would misreport it.

On detection the intervention message is parked for the next turn. Once the session has been
intervened on more than `MAX_INTERVENTIONS` (2) times, the stream is aborted with a clean terminal
frame.

The intervention is a synthetic **system** directive. The carrier is chosen from the **client
format** when it is known, because the body shapes overlap (an Anthropic Messages body carries BOTH
`system` and `messages[]`, so a shape-only detector would route it to the OpenAI branch):

| Client format       | Carrier                                               |
| ------------------- | ----------------------------------------------------- |
| OpenAI Chat / Codex | a `system` / `developer` role message in `messages[]` |
| Anthropic Messages  | the top-level `system` field                          |
| OpenAI Responses    | the top-level `instructions` string                   |
| Gemini              | `systemInstruction.parts[]`                           |

A body with no recognisable carrier is returned **unchanged** (fail OPEN) and the parked
intervention is dropped rather than retried forever.

---

## Reasoning-token bounding

`TokenSentinelTracker` accounts the reasoning text the model streams (OpenAI `reasoning_content` /
`reasoning_details[]`, Anthropic `thinking` / `thinking_delta`, Responses
`response.reasoning_content_text.delta`) and terminates the stream when either limit is crossed:

- the **cumulative ceiling** — `DEFAULT_REASONING_TOKEN_CEILING` (16 000 tokens), overridable through
  `OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING` (positive integers only; a non-numeric, zero or
  negative value falls back to the default rather than disabling the guard);
- the **velocity ceiling** — tokens per second over a rolling 2 s window. Disabled by default
  (`DEFAULT_VELOCITY_CEILING` is `null`); the cumulative ceiling is the primary signal.

The tracker is per in-flight stream and is released on `streamController.signal` abort, so a client
disconnect cannot leak one.

---

## Terminal frames

A governance termination is a **clean terminal frame**, never a raw connection drop. The shapes reuse
the repo's per-format terminal helpers:

| Format             | Frames                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages | `event: error` (the governance reason) then `event: message_stop` — the pair `buildStreamErrorChunks` emits, so the Anthropic SDK / Claude Code treat it as terminal rather than as a dropped connection |
| OpenAI Chat        | a final chunk with `finish_reason: "length"` and the governance error, then `data: [DONE]`                                                                                                               |
| OpenAI Responses   | a `response.failed` event carrying the governance error (with `sequence_number: 1`, the `SYNTHETIC_RESPONSES_SEQUENCE_NUMBER` every synthesized Responses terminal frame uses), then `data: [DONE]`      |

The error body is built through `buildErrorBody()`, so no raw `err.message` / `err.stack` can reach
the client. The identifiers `governance_limit`, `governance_limit_exceeded` and
`governance_loop_aborted` are registered in `SAFE_PUBLIC_ERROR_IDENTIFIERS`
(`open-sse/utils/error.ts`) — without them `projectPublicErrorIdentifier` would collapse the
governance reason to a generic `error`.

---

## Fail open

Every governance step is wrapped. A governance failure returns the body or the chunk **unmodified**
and logs. A governance failure must never corrupt or truncate a user's request or response.

---

## Coverage

The egress tap is inserted into `assembleStreamingPipeline`, which is the chatCore **streaming
success** path. It therefore covers the Chat Completions and Anthropic Messages chat paths.

It does NOT cover these independent byte-emission funnels:

- `open-sse/utils/earlyStreamKeepalive.ts` — route-level keepalive, startup and error frames, which
  are emitted before the pipeline exists (or after it fails).
- `open-sse/handlers/responsesHandler.ts` — the `/v1/responses` worker path re-transforms an
  already-final SSE stream.
- `src/app/api/v1/relay/chat/completions/` — the relay path.
- `src/app/api/v1/completions/route.ts` — the text-completion transform.

---

## Identity and audit

The governance session key is **not** a parallel identity scheme. It reuses the existing primitives:

- `extractExternalSessionId(headers)` (`open-sse/services/sessionManager.ts`) — the client-supplied
  session id, normalized to `ext:<raw≤64>`.
- `generateSessionId(body, {provider, connectionId})` (same file) — the SHA-256 conversation
  fingerprint (16 hex chars), the same value `open-sse/utils/stream.ts` computes for its cross-request
  tool-latency tracking.

The principal is the API-key id (`apiKeyInfo.id`) — the value `chatCore.ts` already uses for
`compressionPrincipalId` and the `mcp_tool_audit.api_key_id` column.

**Caveat (documented, not worked around):** the sessionManager maps are in-memory with a 15-minute
TTL and a 200-session cap, so a session can be evicted between two turns. A session-keyed policy
must therefore tolerate a cold start — the loop breaker's window begins empty again, and the DEGRADED
event is re-emitted under the new session id.

The audit bus records **names and counters only** — never the prompt, never the arguments, never the
tool results. The prompt is stored as a SHA-256 hash (`hashPromptMessages`), which mixes a shape tag
so a `messages[]` body and an `input[]` body cannot collide.

---

## Tests

The governance suites live in `open-sse/governance/__tests__/` and run under vitest:

```bash
npx vitest run open-sse/governance/__tests__/ --config vitest.config.ts
```

| File                            | Covers                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `auditBus.test.ts`              | the ring buffer, the sinks, `hashPromptMessages`                                         |
| `governanceTransform.test.ts`   | the egress tap: pass-through, the block parser, rejection, loop, breach, terminal frames |
| `governanceIngress.test.ts`     | the ingress: intervention injection, rejection rewriting, turn index                     |
| `identity.test.ts`              | the session/principal resolution                                                         |
| `loopBreaker.test.ts`           | repeat / ping-pong detection                                                             |
| `loopIntervention.test.ts`      | the store and the format-aware injection                                                 |
| `tokenSentinel.test.ts`         | the ceiling, the velocity, the reasoning extraction                                      |
| `toolCallAssembler.test.ts`     | the reassembly and the terminal-marker contract                                          |
| `toolRejectionEnforcer.test.ts` | the extraction, the rewriting, the audit-once                                            |
| `toolRejectionLedger.test.ts`   | the shared state and its bounds                                                          |
| `toolSchemaValidator.test.ts`   | the validation, the degraded mode, the rejection shapes                                  |
