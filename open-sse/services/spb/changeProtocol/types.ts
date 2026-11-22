export type Phase = "UNDERSTAND" | "PLAN" | "APPLY" | "VERIFY" | "DONE" | "ROLLED_BACK";
export type ProtocolMode = "off" | "observe";
export interface PhaseBudget {
  maxSeconds: number;
  maxToolCalls: number;
}
export interface ChangeProtocolConfig {
  enabled: boolean;
  mode: ProtocolMode;
  budgets: Record<"UNDERSTAND" | "PLAN" | "APPLY" | "VERIFY", PhaseBudget>;
  taskCeilingSeconds: number;
  stateTtlSeconds: number;
}
export interface PhaseState {
  runId: string;
  phase: Phase;
  runStartedAt: number;
  phaseStartedAt: number;
  planSeen: boolean;
  toolCalls: Record<string, number>;
  budgetFlagged: string[];
  violationCount: number;
}
export type ProtocolEvent =
  | { kind: "run_start" }
  | { kind: "read_tool"; name: string }
  | { kind: "plan_signal" }
  | { kind: "mutation_tool"; name: string }
  | { kind: "verify_command"; command: string };
export interface ViolationEvent {
  type:
    "violation:write_before_plan" | "violation:budget_exceeded" | "violation:task_ceiling_exceeded";
  sessionId: string;
  runId: string;
  phase: Phase;
  detail: string;
}
