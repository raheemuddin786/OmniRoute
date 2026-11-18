import { getTierConfig } from "../../tierResolver.ts";
import type { ChangeProtocolConfig, PhaseBudget, ProtocolMode } from "./types.ts";

const DEFAULT_CONFIG: ChangeProtocolConfig = Object.freeze({
  enabled: false,
  mode: "observe",
  budgets: {
    UNDERSTAND: { maxSeconds: 120, maxToolCalls: 25 },
    PLAN: { maxSeconds: 90, maxToolCalls: 10 },
    APPLY: { maxSeconds: 30, maxToolCalls: 5 },
    VERIFY: { maxSeconds: 180, maxToolCalls: 20 },
  },
  taskCeilingSeconds: 600,
  stateTtlSeconds: 3600,
}) as ChangeProtocolConfig;

function num(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function budget(raw: unknown, fallback: PhaseBudget): PhaseBudget {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    maxSeconds: num(r.maxSeconds, fallback.maxSeconds, 1),
    maxToolCalls: num(r.maxToolCalls, fallback.maxToolCalls, 1),
  };
}

export function getChangeProtocolConfig(spbProfile?: string): ChangeProtocolConfig {
  let raw: Record<string, unknown> = {};
  try {
    const spb = (getTierConfig(spbProfile) as unknown as { spbConfig?: Record<string, unknown> })
      ?.spbConfig;
    const section = spb?.changeProtocol;
    if (section && typeof section === "object") raw = section as Record<string, unknown>;
  } catch {
    raw = {};
  }

  const envMode = (process.env.CHANGE_PROTOCOL_MODE || "").toLowerCase();
  let enabled = raw.enabled === true;
  let mode: ProtocolMode = raw.mode === "off" ? "off" : "observe";
  if (envMode === "off") enabled = false;
  if (envMode === "observe") {
    enabled = true;
    mode = "observe";
  }
  if (mode === "off") enabled = false;

  const b = (raw.budgets && typeof raw.budgets === "object" ? raw.budgets : {}) as Record<
    string,
    unknown
  >;
  return Object.freeze({
    enabled,
    mode,
    budgets: {
      UNDERSTAND: budget(b.understand, DEFAULT_CONFIG.budgets.UNDERSTAND),
      PLAN: budget(b.plan, DEFAULT_CONFIG.budgets.PLAN),
      APPLY: budget(b.apply, DEFAULT_CONFIG.budgets.APPLY),
      VERIFY: budget(b.verify, DEFAULT_CONFIG.budgets.VERIFY),
    },
    taskCeilingSeconds: num(raw.taskCeilingSeconds, DEFAULT_CONFIG.taskCeilingSeconds, 1),
    stateTtlSeconds: num(raw.stateTtlSeconds, DEFAULT_CONFIG.stateTtlSeconds, 60),
  });
}
