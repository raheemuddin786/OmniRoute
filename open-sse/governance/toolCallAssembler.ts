/**
 * Tool-call assembler — turns the client-facing SSE stream back into
 * COMPLETE tool calls, per wire format.
 *
 * WHY A SEPARATE MODULE
 *
 *  The three client wire formats the chatCore streaming path emits all
 *  describe a tool call differently, and in two of the three the arguments
 *  arrive INCREMENTALLY:
 *
 *  | Format    | Name arrives in                     | Arguments arrive in                             | Terminal marker                              |
 *  | --------- | ----------------------------------- | ----------------------------------------------- | -------------------------------------------- |
 *  | OpenAI    | `delta.tool_calls[].function.name`  | `delta.tool_calls[].function.arguments`         | the chunk whose `finish_reason` is set        |
 *  | Anthropic | `content_block_start` (`tool_use`)  | `content_block_delta` (`input_json_delta`)      | `content_block_stop`                          |
 *  | Responses | `response.output_item.added` (`item`)| `response.function_call_arguments.delta`        | `response.function_call_arguments.done`       |
 *
 *  A governance layer that wants to VALIDATE a call therefore has to
 *  accumulate the fragments and know when the call is complete. This module
 *  owns exactly that: it is a stateful assembler with no policy in it.
 *
 *  THE TERMINAL MARKER IS THE ONLY COMPLETION SIGNAL
 *
 *  "The accumulated arguments happen to parse as JSON" is NOT a completion
 *  signal: `{}` is a complete JSON document, so a partial argument stream
 *  that happens to begin with `{}` would be evaluated against a PARTIAL
 *  argument set — and a call that is actually valid could be rejected. The
 *  terminal marker is the format's own statement that the call is finished,
 *  so it is the only signal used here.
 *
 *  WHY THE KEY
 *
 *  Every fragment of one call must map to the same key so the accumulator can
 *  find it again. The key is derived from the format's OWN stable identifier
 *  and is NAMESPACE-PREFIXED by format, so an OpenAI `index:0` and an
 *  Anthropic `index:0` can never collide:
 *
 *  - OpenAI: `openai:idx:<tool_calls[].index>`, falling back to the call id,
 *    then the name.
 *  - Anthropic: `anthropic:idx:<content block index>`.
 *  - Responses: `responses:rid:<output item id>` — the `fc_<call_id>` the
 *    argument events carry in `item_id`.
 *
 *  NOTHING SENSITIVE IS RETAINED
 *
 *  The assembler holds tool NAMES, call ids and the raw argument TEXT of the
 *  calls currently in flight. That text is handed straight to the validator
 *  and then dropped; it is never written to the audit trail (the audit bus
 *  records names and counters only).
 */

export interface ToolCallStart {
  /** Stable key for this call, shared by all of its fragments. */
  key: string;
  /** Tool name as emitted by the model. */
  name: string;
  /** Provider-assigned call id, when the format has one. */
  callId: string | null;
  /** The format that owns the call. */
  format: string;
  /**
   * The format-native index of the call — the OpenAI `tool_calls[].index`,
   * the Anthropic content-block index, the Responses `output_index`. It is
   * what lets a suppressed call's replacement frames reuse the SAME index, so
   * the frame sequence stays contiguous.
   */
  index: number | null;
  /** The last name reported through `ToolCallChunkInfo.names`. */
  reportedName: string;
}

export interface ToolCallArgs {
  key: string;
  /** A raw argument fragment (JSON text). */
  text: string;
}

export interface ToolCallComplete {
  key: string;
  name: string;
  callId: string | null;
  /** The COMPLETE argument text (JSON). Empty string when the call had none. */
  arguments: string;
  /** The format that owns the call. */
  format: string;
  /** The format-native index of the call. */
  index: number | null;
}

export interface ToolCallChunkInfo {
  /** Calls opened by this chunk. */
  starts: ToolCallStart[];
  /**
   * Every sighting of a tool NAME for a call.
   *
   * The name is usually carried by the call's FIRST fragment, but some
   * upstreams stream the id and the name in SEPARATE chunks (GLM 5.2 does
   * exactly that). Reporting every name sighting lets the caller run its
   * EAGER checks (the catalog lookup) at the moment the name becomes known,
   * instead of waiting for the whole call.
   */
  names: ToolCallStart[];
  /** Argument fragments carried by this chunk. */
  args: ToolCallArgs[];
  /** Calls COMPLETED by this chunk (the terminal marker fired). */
  completes: ToolCallComplete[];
  /**
   * The keys whose OWN FRAMES this chunk carries.
   *
   * This is what lets a caller SUPPRESS a rejected call: the frames that
   * announced the call (its name, its argument fragments, and — for the
   * formats that have one — the frame that closes its block) all name the
   * call's key, so dropping the frames of a rejected key removes the call
   * from the wire entirely.
   *
   * A frame that merely CLOSES a turn (the OpenAI `finish_reason` chunk) is
   * NOT a frame of any call — it carries no tool content and names no key —
   * so it survives a rejection.
   */
  touchedKeys: string[];
  /** True when the chunk carried ANY tool-call related content. */
  hasToolContent: boolean;
}

interface PendingCall {
  key: string;
  name: string;
  callId: string | null;
  /** Accumulated argument text. */
  args: string;
  /** True once the arguments are known to be final. */
  argsFinal: boolean;
  /** True once the call has been reported as started. */
  started: boolean;
  /** The format that owns this call ("openai" | "anthropic" | "responses"). */
  format: string;
  /** The format-native index of the call. */
  index: number | null;
  /** The last name reported through `ToolCallChunkInfo.names`. */
  reportedName: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty trimmed string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Accumulate tool calls from a client-facing SSE stream.
 *
 * One instance per stream. Never throws: every accessor is defensive, because
 * a governance failure must never break the user's response.
 */
export class ToolCallAssembler {
  private readonly calls = new Map<string, PendingCall>();

  /**
   * Consume one client-facing SSE payload.
   *
   * The assembler is updated BEFORE the return, so the caller may inspect the
   * result and immediately act on it.
   */
  consume(chunk: unknown): ToolCallChunkInfo {
    const info: ToolCallChunkInfo = {
      starts: [],
      names: [],
      args: [],
      completes: [],
      touchedKeys: [],
      hasToolContent: false,
    };
    const record = asRecord(chunk);
    if (!record) return info;

    try {
      this.consumeOpenAI(record, info);
      this.consumeAnthropic(record, info);
      this.consumeResponses(record, info);
    } catch {
      // Fail OPEN: a malformed frame must never break the stream.
      info.hasToolContent =
        info.starts.length > 0 || info.args.length > 0 || info.completes.length > 0;
    }
    return info;
  }

  /** Calls still in flight (opened, not yet completed). */
  get pendingCount(): number {
    return this.calls.size;
  }

  /** True when at least one call is still in flight. */
  get hasPending(): boolean {
    return this.calls.size > 0;
  }

  /**
   * Complete every in-flight call at end of stream.
   *
   * Used by the `flush` path, where the upstream ended without a terminal
   * marker (a truncated stream). The accumulated arguments are the best
   * available approximation.
   */
  completeAll(): ToolCallComplete[] {
    const out: ToolCallComplete[] = [];
    for (const [key, pending] of this.calls) {
      out.push({
        key,
        name: pending.name,
        callId: pending.callId,
        arguments: pending.args && pending.args.trim() !== "" ? pending.args : "{}",
        format: pending.format,
        index: pending.index,
      });
    }
    this.calls.clear();
    return out;
  }

  // ── shared per-call bookkeeping ──

  /** Report the call as started (once per call). */
  private reportStart(pending: PendingCall, format: string, info: ToolCallChunkInfo): void {
    if (pending.started) return;
    pending.started = true;
    info.starts.push({
      key: pending.key,
      name: pending.name,
      callId: pending.callId,
      format,
      index: pending.index,
      reportedName: pending.name,
    });
  }

  /** Report a name sighting (once per distinct name). */
  private reportName(
    pending: PendingCall,
    name: string,
    format: string,
    info: ToolCallChunkInfo
  ): void {
    if (!name || pending.reportedName === name) return;
    pending.reportedName = name;
    info.names.push({
      key: pending.key,
      name,
      callId: pending.callId,
      format,
      index: pending.index,
      reportedName: name,
    });
  }

  /** Apply the identity fields a fragment carries, when it carries them. */
  private applyIdentity(pending: PendingCall, name: string, callId: string | null): void {
    if (name) pending.name = name;
    if (callId) pending.callId = callId;
  }

  // ── OpenAI Chat Completions ──
  private consumeOpenAI(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const choices = record.choices;
    if (!Array.isArray(choices)) return;

    for (const choice of choices) {
      const c = asRecord(choice);
      if (!c) continue;
      this.consumeOpenAIChoice(c, info);
    }
  }

  private consumeOpenAIChoice(c: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const delta = asRecord(c.delta);
    const message = asRecord(c.message);
    const toolCalls = delta?.tool_calls ?? message?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        this.consumeOpenAIToolCall(raw, info);
      }
    }

    // The terminal chunk of the turn. OpenAI Chat has no per-call terminal
    // event, so the turn's terminal chunk is the format's statement that the
    // tool call is finished.
    if (nonEmptyString(c.finish_reason)) {
      this.completeOpenAICalls(info);
    }
  }

  private consumeOpenAIToolCall(raw: unknown, info: ToolCallChunkInfo): void {
    const tc = asRecord(raw);
    if (!tc) return;
    const fn = asRecord(tc.function);
    const name = nonEmptyString(fn?.name) ?? "";
    const key = this.openAIKey(tc, name);
    const callId = nonEmptyString(tc.id);
    const fragment = typeof fn?.arguments === "string" ? fn.arguments : "";

    const pending = this.ensure(key, name, callId);
    pending.format = "openai";
    if (typeof tc.index === "number") pending.index = tc.index;
    this.applyIdentity(pending, name, callId);

    this.reportStart(pending, "openai", info);
    info.touchedKeys.push(key);
    this.reportName(pending, name, "openai", info);
    if (fragment) {
      pending.args += fragment;
      info.args.push({ key, text: fragment });
    }
    info.hasToolContent = true;
  }

  private completeOpenAICalls(info: ToolCallChunkInfo): void {
    for (const pending of [...this.calls.values()]) {
      if (pending.format !== "openai") continue;
      this.complete(pending, info);
    }
  }

  private openAIKey(tc: Record<string, unknown>, name: string): string {
    if (typeof tc.index === "number") return `openai:idx:${tc.index}`;
    const id = nonEmptyString(tc.id);
    if (id) return `openai:id:${id}`;
    return `openai:name:${name}`;
  }

  // ── Anthropic Messages ──
  private consumeAnthropic(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const type = nonEmptyString(record.type);

    if (type === "content_block_start") {
      this.consumeAnthropicStart(record, info);
      return;
    }
    if (type === "content_block_delta") {
      this.consumeAnthropicDelta(record, info);
      return;
    }
    if (type === "content_block_stop") {
      this.consumeAnthropicStop(record, info);
    }
  }

  private consumeAnthropicStart(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const block = asRecord(record.content_block);
    if (block?.type !== "tool_use") return;
    const key = this.anthropicKey(record.index);
    const name = nonEmptyString(block.name) ?? "";
    const callId = nonEmptyString(block.id);

    const pending = this.ensure(key, name, callId);
    pending.format = "anthropic";
    if (typeof record.index === "number") pending.index = record.index;
    this.applyIdentity(pending, name, callId);

    this.reportStart(pending, "anthropic", info);
    info.touchedKeys.push(key);
    this.reportName(pending, name, "anthropic", info);

    // Some providers send the whole input object in the start frame. When it
    // carries keys, it IS the final argument text.
    const input = asRecord(block.input);
    if (input && Object.keys(input).length > 0) {
      pending.args = JSON.stringify(input);
      pending.argsFinal = true;
    }
    info.hasToolContent = true;
  }

  private consumeAnthropicDelta(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const delta = asRecord(record.delta);
    if (delta?.type !== "input_json_delta") return;
    const key = this.anthropicKey(record.index);
    const fragment = typeof delta.partial_json === "string" ? delta.partial_json : "";

    const pending = this.ensure(key, "", null);
    pending.format = "anthropic";
    if (typeof record.index === "number") pending.index = record.index;

    this.reportStart(pending, "anthropic", info);
    info.touchedKeys.push(key);
    if (fragment) {
      // Some providers deliver the WHOLE input object in the start frame and
      // then ALSO stream `input_json_delta` fragments. Appending on top of
      // the already-final text would duplicate the arguments, so the final
      // text wins and the fragment is dropped.
      if (!pending.argsFinal) {
        pending.args += fragment;
        info.args.push({ key, text: fragment });
      }
    }
    info.hasToolContent = true;
  }

  private consumeAnthropicStop(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const key = this.anthropicKey(record.index);
    const pending = this.calls.get(key);
    if (!pending) return;
    pending.format = "anthropic";
    info.touchedKeys.push(key);
    this.complete(pending, info);
  }

  private anthropicKey(index: unknown): string {
    return `anthropic:idx:${typeof index === "number" ? index : 0}`;
  }

  // ── OpenAI Responses ──
  private consumeResponses(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const type = nonEmptyString(record.type);
    if (!type) return;

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      this.consumeResponsesItem(record, info, type);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      this.consumeResponsesDelta(record, info);
      return;
    }
    if (type === "response.function_call_arguments.done") {
      this.consumeResponsesDone(record, info);
    }
  }

  private consumeResponsesItem(
    record: Record<string, unknown>,
    info: ToolCallChunkInfo,
    type: string
  ): void {
    const item = asRecord(record.item);
    if (!item) return;
    const itemType = nonEmptyString(item.type);
    if (itemType !== "function_call" && itemType !== "custom_tool_call") return;

    const key = this.responsesKey(record.item_id ?? item.id);
    const name = nonEmptyString(item.name) ?? "";
    const callId = nonEmptyString(item.call_id);

    const pending = this.ensure(key, name, callId);
    pending.format = "responses";
    if (typeof record.output_index === "number") pending.index = record.output_index;
    this.applyIdentity(pending, name, callId);

    this.reportStart(pending, "responses", info);
    info.touchedKeys.push(key);
    this.reportName(pending, name, "responses", info);
    info.hasToolContent = true;

    if (type !== "response.output_item.done") return;
    // The item carries the complete arguments.
    const args = typeof item.arguments === "string" ? item.arguments : "";
    if (args) {
      pending.args = args;
      pending.argsFinal = true;
    }
    this.complete(pending, info);
  }

  private consumeResponsesDelta(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const key = this.responsesKey(record.item_id);
    const fragment = typeof record.delta === "string" ? record.delta : "";

    const pending = this.ensure(key, "", null);
    pending.format = "responses";
    if (typeof record.output_index === "number") pending.index = record.output_index;

    this.reportStart(pending, "responses", info);
    info.touchedKeys.push(key);
    if (fragment) {
      pending.args += fragment;
      info.args.push({ key, text: fragment });
    }
    info.hasToolContent = true;
  }

  private consumeResponsesDone(record: Record<string, unknown>, info: ToolCallChunkInfo): void {
    const key = this.responsesKey(record.item_id);

    const pending = this.ensure(key, "", null);
    pending.format = "responses";
    if (typeof record.output_index === "number") pending.index = record.output_index;
    const args = typeof record.arguments === "string" ? record.arguments : "";
    if (args) {
      pending.args = args;
      pending.argsFinal = true;
    }

    this.reportStart(pending, "responses", info);
    info.touchedKeys.push(key);
    this.complete(pending, info);
  }

  private responsesKey(itemId: unknown): string {
    const id = nonEmptyString(itemId);
    return `responses:rid:${id ?? "unknown"}`;
  }

  // ── internals ──
  private ensure(key: string, name: string, callId: string | null): PendingCall {
    let pending = this.calls.get(key);
    if (!pending) {
      pending = {
        key,
        name,
        callId,
        args: "",
        argsFinal: false,
        started: false,
        format: "",
        index: null,
        reportedName: "",
      };
      this.calls.set(key, pending);
    }
    return pending;
  }

  private complete(pending: PendingCall, info: ToolCallChunkInfo): void {
    this.calls.delete(pending.key);
    info.completes.push({
      key: pending.key,
      name: pending.name,
      callId: pending.callId,
      arguments: pending.args && pending.args.trim() !== "" ? pending.args : "{}",
      format: pending.format,
      index: pending.index,
    });
    info.hasToolContent = true;
  }
}
