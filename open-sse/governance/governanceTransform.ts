/**
 * Governance egress transform — the client-facing byte tap.
 *
 * This is the ONE place the governance modules meet the request pipeline. It is
 * a `TransformStream<Uint8Array, Uint8Array>` factory, matching the shape of
 * every other transform in the streaming chain (`createPiiSseTransform`,
 * `createSseHeartbeatTransform`, `createModelEchoTransform`), and it is
 * injected into the chain through `StreamingPipelineDeps`.
 *
 * WHAT IT DOES, PER CHUNK
 *
 *  1. Parses the client-facing SSE frames (JSON payloads only; `event:` and
 *     comment lines are passed through untouched).
 *  2. Feeds any reasoning delta to the `TokenSentinelTracker` for the stream.
 *     On a ceiling breach it emits a CLEAN TERMINATION for the client format
 *     and stops the stream — a well-formed terminal frame, NOT a raw
 *     connection drop.
 *  3. Accumulates the tool calls the model requested (per wire format, via
 *     `ToolCallAssembler`), validates each COMPLETE call against the
 *     request's own tool catalog, and observes the loop breaker.
 *
 * WHAT IT DOES ON A VIOLATION
 *
 *  A rejected tool call is recorded in the shared rejection ledger and
 *  audited ONCE. The DELIVERY of the rejection to the model happens on the
 *  NEXT turn's request (see `toolRejectionEnforcer.ts`): a response stream
 *  carries tool CALLS, never tool RESULTS, so the proxy cannot deliver a tool
 *  result on the egress without corrupting the client's own tool execution.
 *
 *  A detected LOOP is handled inline: the intervention message is parked for
 *  the next turn (see `loopIntervention.ts`) and, once the session has been
 *  intervened on more than `MAX_INTERVENTIONS` times, the stream is aborted
 *  with a CLEAN terminal frame.
 *
 * SCOPE — WHICH PATHS THIS TAP COVERS (AND WHICH IT DOES NOT)
 *
 *  This transform is inserted into `assembleStreamingPipeline`
 *  (`open-sse/handlers/chatCore/streamingPipeline.ts`), which is the chatCore
 *  streaming success path. It therefore covers the Chat Completions and
 *  Anthropic Messages chat paths.
 *
 *  It does NOT cover these independent byte-emission funnels:
 *
 *  - `open-sse/utils/earlyStreamKeepalive.ts` — route-level keepalive,
 *    startup and error frames. These are emitted BEFORE the pipeline exists
 *    (or after it fails), so they never reach this tap.
 *  - `open-sse/handlers/responsesHandler.ts` — the `/v1/responses` worker
 *    path re-transforms an ALREADY-FINAL SSE stream, so a tap there would see
 *    a different shape than the one this transform expects.
 *  - `src/app/api/v1/relay/chat/completions/` — the relay path.
 *  - `src/app/api/v1/completions/route.ts` — the text-completion transform.
 *
 *  The `KNOWN LIMITATIONS` section of the implementation report states this
 *  explicitly. The unit tests do NOT assume coverage of the uncovered paths.
 *
 * FAIL OPEN
 *
 *  Every internal error in this transform forwards the chunk UNMODIFIED and
 *  logs. A governance failure must never corrupt or truncate a user's
 *  response.
 */

import { FORMATS } from "../translator/formats.ts";
import { logger } from "../utils/logger.ts";
import { buildErrorBody } from "../utils/error.ts";
import { SYNTHETIC_RESPONSES_SEQUENCE_NUMBER } from "../utils/responsesSequence.ts";
import { extractStreamTexts } from "./tokenSentinel.ts";
import { buildLoopInterventionMessage, fingerprintToolCall } from "./loopBreaker.ts";
import { validateToolCall, auditToolCallRejection } from "./toolSchemaValidator.ts";
import { recordGovernanceAudit } from "./auditBus.ts";
import { registerLoopIntervention } from "./loopIntervention.ts";
import { buildRejectionKey, getToolRejectionLedger } from "./toolRejectionLedger.ts";
import { ToolCallAssembler } from "./toolCallAssembler.ts";
import type { TokenSentinelTracker, TokenSentinelBreach } from "./tokenSentinel.ts";
import type { LoopBreaker, LoopDetection } from "./loopBreaker.ts";
import type { ToolCallValidationContext, ToolCallRejectionReason } from "./toolSchemaValidator.ts";

const log = logger("GOVERNANCE");

export interface GovernanceTransformOptions {
  /** Client wire format — selects the terminal frame shape. */
  clientFormat?: string | null;
  /** The token sentinel tracker for this stream (owned by the caller). */
  tokenTracker?: TokenSentinelTracker | null;
  /** The loop breaker (process-wide or injected). */
  loopBreaker?: LoopBreaker | null;
  /** Existing session identity. */
  sessionId: string;
  /** API-key id when known. */
  principalId?: string;
  /** Request correlation id. */
  requestId?: string;
  model?: string;
  provider?: string;
  turnIndex?: number;
  /** The request body — the tool catalog source. */
  body?: unknown;
  /**
   * Called when the sentinel breaches its ceiling. The caller owns the actual
   * termination; this transform only stops forwarding further upstream bytes.
   */
  onBreach?: (breach: TokenSentinelBreach) => void;
  /**
   * Called when the loop breaker escalates to a hard abort. The caller owns the
   * actual stream termination; this transform stops forwarding further
   * upstream bytes and emits the clean terminal frames itself.
   */
  onLoopAbort?: (detection: { kind: string; count: number; interventions: number }) => void;
}

const encoder = new TextEncoder();

/**
 * Parse the assembler's raw argument text into structured arguments.
 *
 * The assembler hands over the argument TEXT (the format's own representation:
 * a JSON string for OpenAI and Responses, the accumulated `input_json_delta`
 * text for Anthropic). A string that is not valid JSON is returned AS-IS so
 * the validator can report it as `malformed_arguments` (a model error) rather
 * than as an internal governance error.
 */
function parseArgumentText(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/**
 * Build the CLEAN terminal frames for a client format.
 *
 * Reuses the repo's OWN per-format terminal shapes (the ones
 * `open-sse/utils/streamHandler.ts` and `open-sse/utils/streamErrorFormat.ts`
 * already emit), so the client sees a protocol-correct terminal event rather
 * than a dropped connection:
 *
 *  - OpenAI Chat: a final chunk carrying `finish_reason: "length"` (a valid
 *    OpenAI finish reason) plus the governance error, then `data: [DONE]` —
 *    the same shape `buildStreamErrorChunks` builds for the OpenAI branch.
 *  - Anthropic (`claude`): an `event: error` frame carrying the reason,
 *    followed by `event: message_stop` — the exact pair `buildStreamErrorChunks`
 *    emits for Claude, and the fix for #7699: without `message_stop` the
 *    Anthropic SDK / Claude Code report "Connection closed mid-response".
 *  - Responses (`openai-responses`): a `response.failed` event with
 *    `status: "failed"` and the synthetic `sequence_number` seed the repo
 *    uses for every synthesized Responses terminal (#15202) — a strict
 *    Responses decoder aborts on a `response.failed` frame without it.
 *
 * The error text is produced through `buildErrorBody()`, so no raw
 * `err.message` / `err.stack` can reach the client (Hard Rule #12).
 */
export function buildGovernanceTerminalFrames(
  clientFormat: string | null | undefined,
  message: string,
  reason: "ceiling" | "loop" = "ceiling"
): Uint8Array[] {
  const errorBody = buildErrorBody(429, message, undefined, {
    type: "governance_limit",
    code: reason === "loop" ? "governance_loop_aborted" : "governance_limit_exceeded",
  });

  if (clientFormat === FORMATS.CLAUDE) {
    return [
      encoder.encode(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: {
            type: errorBody.error.type,
            message: errorBody.error.message,
            code: errorBody.error.code,
          },
        })}\n\n`
      ),
      encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
    ];
  }

  if (clientFormat === FORMATS.OPENAI_RESPONSES) {
    return [
      encoder.encode(
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          sequence_number: SYNTHETIC_RESPONSES_SEQUENCE_NUMBER,
          response: {
            id: "resp_governance",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "failed",
            error: errorBody.error,
            output: [],
          },
        })}\n\n`
      ),
      encoder.encode("data: [DONE]\n\n"),
    ];
  }

  // OpenAI Chat Completions.
  return [
    encoder.encode(
      `data: ${JSON.stringify({
        id: "chatcmpl-governance",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "governance",
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        error: errorBody.error,
      })}\n\n`
    ),
    encoder.encode("data: [DONE]\n\n"),
  ];
}

/**
 * The SSE frame separator — a blank line.
 *
 * Both `\n\n` and `\r\n\r\n` are accepted.
 */
const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Extract the JSON payload of ONE SSE frame.
 *
 * Returns `null` when the frame carries no `data:` line, when the payload is
 * the `[DONE]` sentinel, or when the payload is not JSON. The caller forwards
 * the original bytes in every one of those cases.
 *
 * The `data:` line is looked for INSIDE the frame (the frame's lines are
 * split first), which is what makes the two-line Anthropic format work.
 */
function extractFramePayload(frame: string): unknown {
  let data = "";
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length).trim();
    // A frame may carry several `data:` lines; the SSE spec concatenates them.
    data = data ? `${data}\n${value}` : value;
  }
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * The per-stream state of the governance tap.
 *
 * A class (rather than one long closure) so each step is a small, individually
 * readable method instead of a single nested function — the egress tap carries
 * three independent policies (token sentinel, tool validation, loop breaking)
 * and one function would hide them behind each other.
 */
class GovernanceEgressTap {
  private readonly decoder = new TextDecoder();
  private readonly assembler = new ToolCallAssembler();
  private buffer = "";
  private terminated = false;

  constructor(private readonly options: GovernanceTransformOptions) {}

  /** The validation context shared by the validator and the audit rows. */
  private validationContext(): ToolCallValidationContext {
    const options = this.options;
    return {
      body: options.body,
      sessionId: options.sessionId,
      ...(options.principalId !== undefined ? { principalId: options.principalId } : {}),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.clientFormat ? { clientFormat: options.clientFormat } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.turnIndex !== undefined ? { turnIndex: options.turnIndex } : {}),
    };
  }

  /** Emit the clean terminal frames for the client format. */
  private flushTerminal(
    controller: TransformStreamDefaultController<Uint8Array>,
    message: string,
    reason: "ceiling" | "loop"
  ): void {
    const frames = buildGovernanceTerminalFrames(this.options.clientFormat, message, reason);
    for (const frame of frames) controller.enqueue(frame);
  }

  /**
   * Record a rejected call in the ledger and audit it ONCE.
   *
   * The rejection is recorded per CALL ID — the id the next turn's request
   * echoes back, so the ingress enforcement can find it and rewrite the tool
   * result. When the wire format carries no call id, a stable synthetic key is
   * derived from the tool name + the canonical arguments, so the same call is
   * still audited only once.
   *
   * The key is SCOPED to the session: a provider call id is unique only within
   * one conversation, so an unscoped key would let this conversation's
   * rejection be applied to an unrelated conversation that reuses the same
   * call id.
   */
  private rejectToolCall(
    call: { name: string; callId: string | null; args: unknown },
    outcome: { reason: ToolCallRejectionReason; message: string },
    context: ToolCallValidationContext
  ): void {
    const wireKey =
      call.callId || `synthetic:${call.name}:${fingerprintToolCall(call.name, call.args)}`;
    const rejectionKey = buildRejectionKey(context.sessionId, wireKey);
    const ledger = getToolRejectionLedger();
    ledger.record(rejectionKey, call.name, outcome.reason, outcome.message);
    if (ledger.markAudited(rejectionKey)) {
      auditToolCallRejection(
        { name: call.name, arguments: call.args, callId: call.callId || null },
        outcome.reason,
        context
      );
    }
    log.warn("tool call rejected by governance", {
      tool: call.name,
      reason: outcome.reason,
      sessionId: this.options.sessionId,
    });
  }

  /** Audit a detected loop. */
  private auditLoop(detection: LoopDetection, toolName: string): void {
    recordGovernanceAudit({
      sessionId: this.options.sessionId,
      turnIndex: this.options.turnIndex ?? 0,
      promptHash: "",
      toolCallsRequested: [toolName],
      toolCallsExecuted: [],
      tokensIn: 0,
      tokensOut: 0,
      model: this.options.model ?? "",
      provider: this.options.provider ?? "",
      compressionApplied: false,
      ...(this.options.principalId !== undefined ? { principalId: this.options.principalId } : {}),
      ...(this.options.requestId !== undefined ? { requestId: this.options.requestId } : {}),
      event: "loop.detected",
      details: {
        kind: detection.kind,
        count: detection.count,
        interventions: detection.interventions,
        shouldAbort: detection.shouldAbort,
      },
    });
  }

  /**
   * Handle a detected loop: abort the stream when the intervention budget is
   * spent, otherwise park the intervention for the next turn.
   */
  private handleLoop(
    detection: LoopDetection,
    call: { name: string },
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    log.warn("loop detected by governance", {
      kind: detection.kind,
      count: detection.count,
      interventions: detection.interventions,
      shouldAbort: detection.shouldAbort,
      sessionId: this.options.sessionId,
    });
    this.auditLoop(detection, call.name);

    if (!detection.shouldAbort) {
      // Park the intervention for the next turn of this session.
      registerLoopIntervention(
        this.options.sessionId,
        buildLoopInterventionMessage(detection, call.name)
      );
      return;
    }

    // The loop persisted past the intervention budget — hard-abort the stream
    // with a CLEAN finish reason (not a raw connection drop).
    this.terminated = true;
    try {
      this.options.onLoopAbort?.({
        kind: detection.kind,
        count: detection.count,
        interventions: detection.interventions,
      });
    } catch (err) {
      log.error("governance loop-abort callback failed (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.flushTerminal(
      controller,
      "Request stopped by the proxy governance layer: the model repeated the same action.",
      "loop"
    );
  }

  /** Validate one COMPLETE tool call and observe the loop breaker. */
  private handleToolCall(
    call: { name: string; callId: string | null; args: unknown },
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    const context = this.validationContext();

    // The assembler hands over the raw argument TEXT. Parsing it here means
    // the validator and the loop breaker both see the SAME structured
    // arguments, so the loop fingerprint is comparable across wire formats
    // (OpenAI streams a JSON string, Anthropic an object).
    const args = parseArgumentText(call.args);
    const descriptor = { name: call.name, arguments: args, callId: call.callId || null };

    const outcome = validateToolCall(descriptor, context);
    if (outcome.ok === false) {
      this.rejectToolCall({ name: call.name, callId: call.callId, args }, outcome, context);
    }

    if (!this.options.loopBreaker) return;
    const detection = this.options.loopBreaker.observe(this.options.sessionId, call.name, args);
    if (!detection) return;
    this.handleLoop(detection, call, controller);
  }

  /**
   * Account the payload's reasoning and content stream text against the token sentinel
   * and degenerate repetition detector.
   *
   * Returns true when the stream was terminated.
   */
  private checkTokenSentinel(
    payload: unknown,
    controller: TransformStreamDefaultController<Uint8Array>
  ): boolean {
    const tracker = this.options.tokenTracker;
    if (!tracker) return false;

    const streamTexts = extractStreamTexts(payload);
    if (streamTexts.length === 0) return false;

    let breach: TokenSentinelBreach | null = null;
    for (const item of streamTexts) {
      breach = tracker.observeText(item.text, item.isReasoning);
      if (breach) break;
    }
    if (!breach) return false;

    this.terminated = true;
    try {
      this.options.onBreach?.(breach);
    } catch (err) {
      log.error("governance breach callback failed (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const message =
      breach.kind === "repetition"
        ? "Request stopped by the proxy governance layer: model entered degenerate repetitive generation loop."
        : "Request stopped by the proxy governance layer: the reasoning budget was exhausted.";
    const finishReason = breach.kind === "repetition" ? "loop" : "ceiling";

    this.flushTerminal(controller, message, finishReason);
    return true;
  }

  /** Inspect one SSE payload: the token sentinel first, then the tool calls. */
  private handlePayload(
    payload: unknown,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    if (this.checkTokenSentinel(payload, controller)) return;

    // The assembler completes a call only on the format's own TERMINAL marker
    // (the OpenAI `finish_reason` chunk, the Anthropic `content_block_stop`, the
    // Responses `response.function_call_arguments.done`), so a partially
    // streamed call is never validated against a partial argument set.
    const info = this.assembler.consume(payload);
    for (const call of info.completes) {
      if (!call.name) continue;
      this.handleToolCall(
        { name: call.name, callId: call.callId, args: call.arguments },
        controller
      );
      if (this.terminated) return;
    }
  }

  /**
   * Consume one chunk: split it into SSE FRAMES and inspect each payload.
   *
   * The buffer is split on the frame separator (a blank line), not on lines.
   * A LINE-oriented parser cannot see the Anthropic Messages payload: that
   * format emits a two-line frame (`event: <name>` then `data: {...}`), so a
   * parser that only inspects whole lines never finds a line that starts with
   * `data:` and the whole Anthropic tool-call stream escapes governance.
   */
  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.terminated) return;
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });

      let match = FRAME_SEPARATOR.exec(this.buffer);
      while (match !== null) {
        const frame = this.buffer.slice(0, match.index);
        this.buffer = this.buffer.slice(match.index + match[0].length);

        const payload = extractFramePayload(frame);
        if (payload !== null) {
          this.handlePayload(payload, controller);
        }
        if (this.terminated) {
          // The terminal frames were already enqueued; drop the rest.
          this.buffer = "";
          return;
        }
        // Forward the frame's ORIGINAL bytes — the governance tap inspects the
        // payload but never rewrites it.
        controller.enqueue(encoder.encode(frame + match[0]));

        match = FRAME_SEPARATOR.exec(this.buffer);
      }
    } catch (err) {
      // Fail OPEN: forward the chunk unmodified.
      log.error("governance transform failed; forwarding unmodified (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.buffer = "";
      try {
        controller.enqueue(chunk);
      } catch {
        /* the controller may already be closed — nothing more to do */
      }
    }
  }

  /**
   * End of stream: judge the calls the upstream never terminated, then forward
   * the trailing bytes.
   */
  flush(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.terminated) return;
    try {
      // A truncated stream (the upstream ended without a terminal marker) still
      // carries the accumulated arguments — the best available approximation of
      // the complete call.
      for (const call of this.assembler.completeAll()) {
        if (!call.name) continue;
        this.handleToolCall(
          { name: call.name, callId: call.callId, args: call.arguments },
          controller
        );
        if (this.terminated) return;
      }
      const tail = this.buffer + this.decoder.decode();
      if (tail) controller.enqueue(encoder.encode(tail));
    } catch {
      /* fail-open: a flush error must not break the response */
    }
  }
}

/**
 * Create the governance egress transform.
 *
 * The returned transform:
 *  - forwards every chunk UNMODIFIED unless the token sentinel breaches or the
 *    loop breaker escalates to a hard abort;
 *  - on breach, forwards nothing further and emits the clean terminal frames;
 *  - on ANY internal error, forwards the chunk unmodified and logs.
 */
export function createGovernanceTransform(
  options: GovernanceTransformOptions
): TransformStream<Uint8Array, Uint8Array> {
  const tap = new GovernanceEgressTap(options);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => tap.transform(chunk, controller),
    flush: (controller) => tap.flush(controller),
  });
}
