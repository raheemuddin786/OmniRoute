import { NextResponse } from "next/server";
import { getSpbRecoveryDaemon } from "@/lib/spbRecoveryDaemon";
import { getDbInstance } from "@/lib/db/core";
import { getTierConfig } from "@omniroute/open-sse/services/tierResolver";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const checks: Record<string, { status: "pass" | "warn" | "fail"; details?: unknown }> = {};
  let overallHealthy = true;

  // 1. Check SPB Recovery Daemon health
  try {
    const daemon = getSpbRecoveryDaemon();
    const status = daemon?.getStatus();
    const isRunning = status?.running === true;
    const lastRunAgoMs = status?.lastRun ? Date.now() - status.lastRun : null;
    const isStalled = lastRunAgoMs !== null && lastRunAgoMs > 120_000;

    if (!isRunning) {
      checks.daemon = {
        status: "warn",
        details: { running: false, note: "Daemon is stopped or inactive" },
      };
    } else if (isStalled) {
      checks.daemon = {
        status: "fail",
        details: { running: true, lastRunAgoMs, note: "Daemon sweep stalled (>120s)" },
      };
      overallHealthy = false;
    } else {
      checks.daemon = { status: "pass", details: { running: true, lastRunAgoMs } };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.daemon = { status: "warn", details: { error: msg } };
  }

  // 2. Check Database Checkpoint connectivity
  try {
    const db = getDbInstance();
    const countRow = db.prepare("SELECT COUNT(*) as count FROM spb_state_checkpoints").get() as
      { count: number } | undefined;
    checks.database = {
      status: "pass",
      details: { totalCheckpoints: countRow?.count ?? 0 },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.database = { status: "fail", details: { error: msg } };
    overallHealthy = false;
  }

  // 3. Check Tier Config validity
  try {
    const tierConfig = getTierConfig();
    const hasApex =
      Array.isArray(tierConfig?.tierModels?.apex) && tierConfig.tierModels.apex.length > 0;
    const hasResilient =
      Array.isArray(tierConfig?.tierModels?.resilient) &&
      tierConfig.tierModels.resilient.length > 0;
    const hasLocal =
      Array.isArray(tierConfig?.tierModels?.local) && tierConfig.tierModels.local.length > 0;

    if (hasApex && hasResilient && hasLocal) {
      checks.tierConfig = {
        status: "pass",
        details: {
          apex: tierConfig.tierModels.apex.length,
          resilient: tierConfig.tierModels.resilient.length,
          local: tierConfig.tierModels.local.length,
        },
      };
    } else {
      checks.tierConfig = {
        status: "warn",
        details: { note: "Some tiers have 0 configured candidate models" },
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.tierConfig = { status: "warn", details: { error: msg } };
  }

  const httpStatus = overallHealthy ? 200 : 503;
  return NextResponse.json(
    {
      status: overallHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: httpStatus }
  );
}
