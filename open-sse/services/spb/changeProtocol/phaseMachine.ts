import type {
  ChangeProtocolConfig,
  Phase,
  PhaseState,
  ProtocolEvent,
  ViolationEvent,
} from "./types.ts";

export function createState(runId: string, now: number): PhaseState {
  return {
    runId,
    phase: "UNDERSTAND",
    runStartedAt: now,
    phaseStartedAt: now,
    planSeen: false,
    toolCalls: {},
    budgetFlagged: [],
    violationCount: 0,
  };
}

function enter(state: PhaseState, phase: Phase, now: number): PhaseState {
  if (state.phase === phase) return state;
  return { ...state, phase, phaseStartedAt: now };
}

export interface TransitionResult {
  state: PhaseState;
  violations: Array<Omit<ViolationEvent, "sessionId">>;
}

export function nextPhase(
  prev: PhaseState,
  event: ProtocolEvent,
  config: ChangeProtocolConfig,
  now: number
): TransitionResult {
  const violations: TransitionResult["violations"] = [];
  let state: PhaseState = { ...prev, toolCalls: { ...prev.toolCalls } };

  switch (event.kind) {
    case "run_start":
      return { state: createState(prev.runId, now), violations };

    case "read_tool":
      state.toolCalls[state.phase] = (state.toolCalls[state.phase] || 0) + 1;
      break;

    case "plan_signal":
      state.planSeen = true;
      if (state.phase === "UNDERSTAND") state = enter(state, "PLAN", now);
      break;

    case "mutation_tool":
      if (!state.planSeen && (state.phase === "UNDERSTAND" || state.phase === "PLAN")) {
        violations.push({
          type: "violation:write_before_plan",
          runId: state.runId,
          phase: state.phase,
          detail: `${event.name} called in ${state.phase} after ${state.toolCalls[state.phase] || 0} read calls`,
        });
      }
      state = enter(state, "APPLY", now);
      state.toolCalls.APPLY = (state.toolCalls.APPLY || 0) + 1;
      break;

    case "verify_command":
      state = enter(state, "VERIFY", now);
      state.toolCalls.VERIFY = (state.toolCalls.VERIFY || 0) + 1;
      break;
  }

  const active = state.phase;
  if (active === "UNDERSTAND" || active === "PLAN" || active === "APPLY" || active === "VERIFY") {
    const limit = config.budgets[active];
    const elapsed = (now - state.phaseStartedAt) / 1000;
    const calls = state.toolCalls[active] || 0;
    const flagKey = `budget:${active}`;
    if (
      (elapsed > limit.maxSeconds || calls > limit.maxToolCalls) &&
      !state.budgetFlagged.includes(flagKey)
    ) {
      state.budgetFlagged = [...state.budgetFlagged, flagKey];
      violations.push({
        type: "violation:budget_exceeded",
        runId: state.runId,
        phase: active,
        detail: `${active}: ${Math.round(elapsed)}s/${limit.maxSeconds}s, ${calls}/${limit.maxToolCalls} tool calls`,
      });
    }
  }

  const total = (now - state.runStartedAt) / 1000;
  if (total > config.taskCeilingSeconds && !state.budgetFlagged.includes("ceiling")) {
    state.budgetFlagged = [...state.budgetFlagged, "ceiling"];
    violations.push({
      type: "violation:task_ceiling_exceeded",
      runId: state.runId,
      phase: state.phase,
      detail: `run elapsed ${Math.round(total)}s > ${config.taskCeilingSeconds}s`,
    });
  }

  state.violationCount += violations.length;
  return { state, violations };
}
