import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  getSpbActivityRecords,
  getSpbDetailedMetrics,
  getEnhancedGovernanceMetrics,
  SpbActivityFilterOptions,
} from "@/lib/db/spbState";

/**
 * GET /api/spb/activity
 *
 * Returns paginated SPB routing records and detailed metrics with time/date and tier filters.
 * Requires management authentication.
 */
export async function GET(request: Request) {
  const authResponse = await requireManagementAuth(request);
  if (authResponse) return authResponse;

  try {
    const { searchParams } = new URL(request.url);

    const timeRange = searchParams.get("timeRange") || undefined;
    const startTimeParam = searchParams.get("startTime");
    const endTimeParam = searchParams.get("endTime");
    const startTime = startTimeParam ? parseInt(startTimeParam, 10) : undefined;
    const endTime = endTimeParam ? parseInt(endTimeParam, 10) : undefined;

    const tier = searchParams.get("tier") || undefined;
    const taskPhase = searchParams.get("taskPhase") || undefined;
    const sessionId = searchParams.get("sessionId") || searchParams.get("search") || undefined;

    const limitParam = searchParams.get("limit");
    const offsetParam = searchParams.get("offset");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const offset = offsetParam ? parseInt(offsetParam, 10) : 0;

    const options: SpbActivityFilterOptions = {
      timeRange,
      startTime: Number.isFinite(startTime) ? startTime : undefined,
      endTime: Number.isFinite(endTime) ? endTime : undefined,
      tier,
      taskPhase,
      sessionId,
      limit,
      offset,
    };

    const { records, total } = getSpbActivityRecords(options);
    const metrics = getSpbDetailedMetrics(options);
    const governance = getEnhancedGovernanceMetrics(options);

    return NextResponse.json({
      success: true,
      records,
      total,
      limit,
      offset,
      metrics,
      governance,
    });
  } catch (err) {
    console.error("[API] GET /api/spb/activity error:", err);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to load SPB activity records",
        records: [],
        total: 0,
      },
      { status: 500 }
    );
  }
}
