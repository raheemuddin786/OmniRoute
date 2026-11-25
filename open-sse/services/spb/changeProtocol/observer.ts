import { getChangeProtocolConfig } from "./config.ts";
import { createState, nextPhase } from "./phaseMachine.ts";
import { loadState, saveState } from "./phaseStore.ts";
import type { PhaseState, ProtocolEvent } from "./types.ts";

// Same list as intentAnalyzer.ts mutationToolNameRegex. Keep the two in sync.
const MUTATION_TOOL =
  /^(?:edit|write|write_file|edit_file|file_write|patch|apply_diff|save_file|create_file)$/i;
const PLAN_TOOL = /^(?:exitplanmode|submit_plan|enterplanmode)$/i;
const VERIFY_COMMAND = /\bnpm\s+run\s+(?:build|lint|typecheck)\b/i;

export interface ObserveInput {
  sessionId: string;
  messages: unknown[];
  isToolResultTurn: boolean;
  taskPhase?: string;
  spbProfile?: string;
  injectedDirective?: string;
}

interface ToolUse {
  name: string;
  command: string;
}

function lastAssistantToolUses(messages: unknown[]): ToolUse[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | null;
    if (!m || m.role !== "assistant") continue;
    const out: ToolUse[] = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part && part.type === "tool_use" && typeof part.name === "string") {
          const input = (part.input || {}) as Record<string, unknown>;
          out.push({
            name: part.name,
            command: typeof input.command === "string" ? input.command : "",
          });
        }
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = (tc?.function || {}) as Record<string, unknown>;
        if (typeof fn.name === "string") {
          let command = "";
          try {
            const args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : {};
            if (typeof args.command === "string") command = args.command;
          } catch {
            /* malformed arguments are ignored */
          }
          out.push({ name: fn.name, command });
        }
      }
    }
    return out;
  }
  return [];
}

function toEvents(uses: ToolUse[]): ProtocolEvent[] {
  return uses.map((u): ProtocolEvent => {
    if (PLAN_TOOL.test(u.name)) return { kind: "plan_signal" };
    if (MUTATION_TOOL.test(u.name)) return { kind: "mutation_tool", name: u.name };
    if (/^bash$/i.test(u.name) && VERIFY_COMMAND.test(u.command)) {
      return { kind: "verify_command", command: u.command };
    }
    return { kind: "read_tool", name: u.name };
  });
}

export async function observeChangeProtocol(input: ObserveInput): Promise<void> {
  try {
    const config = getChangeProtocolConfig(input.spbProfile);
    if (!config.enabled || config.mode !== "observe") return;

    const now = Date.now();
    let state: PhaseState | null = await loadState(input.sessionId);
    const events: ProtocolEvent[] = [];

    if (!state || !input.isToolResultTurn) {
      state = createState(`${input.sessionId}:${now}`, now);
      events.push({ kind: "run_start" });
    }
    if (input.taskPhase === "ARCHITECTURAL_PLANNING") events.push({ kind: "plan_signal" });
    const spbMandateInjected =
      input.injectedDirective?.includes("formulate a complete multi-file plan") ||
      input.injectedDirective?.includes("multi-file plan") ||
      input.injectedDirective?.includes("pre-plan");
    if (spbMandateInjected) events.push({ kind: "plan_signal" });
    if (input.isToolResultTurn) events.push(...toEvents(lastAssistantToolUses(input.messages)));

    let current: PhaseState = state;
    for (const event of events) {
      const result = nextPhase(current, event, config, now);
      current = result.state;
      for (const v of result.violations) {
        console.warn(
          `[ChangeProtocol] ${v.type} | Session ${input.sessionId} | Run ${v.runId} | Phase ${v.phase} | ${v.detail}`
        );
      }
    }
    if (events.length === 0) {
      current = nextPhase(current, { kind: "read_tool", name: "none" }, config, now).state;
      current.toolCalls[current.phase] = Math.max(0, (current.toolCalls[current.phase] || 1) - 1);
    }

    await saveState(input.sessionId, current, config.stateTtlSeconds);
  } catch (err) {
    console.warn("[ChangeProtocol] observer error (ignored):", String(err));
  }
}
