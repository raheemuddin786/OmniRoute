import { NextResponse } from "next/server";
import { getDbInstance } from "@/lib/db/core";

export async function GET() {
  try {
    const db = getDbInstance();

    // Check if table exists
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spb_shadow_audit'")
      .get();

    if (!tableExists) {
      return NextResponse.json({
        totalEvaluated: 0,
        modelAgreementRate: 0,
        avgLatencyDeltaMs: 0,
        tierDistribution: {},
      });
    }

    const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM spb_shadow_audit").get() as
      { cnt: number } | undefined;
    const agreementRow = db
      .prepare("SELECT COUNT(*) as cnt FROM spb_shadow_audit WHERE legacy_model = spb_model")
      .get() as { cnt: number } | undefined;
    const avgLatencyRow = db
      .prepare("SELECT AVG(latency_delta_ms) as avg_lat FROM spb_shadow_audit")
      .get() as { avg_lat: number | null } | undefined;
    const tierRows = db
      .prepare("SELECT spb_tier, COUNT(*) as cnt FROM spb_shadow_audit GROUP BY spb_tier")
      .all() as Array<{ spb_tier: string; cnt: number }>;

    const total = totalRow?.cnt || 0;
    const agreement = agreementRow?.cnt || 0;

    const tierDistribution: Record<string, number> = {};
    for (const r of tierRows) {
      tierDistribution[r.spb_tier] = r.cnt;
    }

    return NextResponse.json({
      totalEvaluated: total,
      modelAgreementRate: total > 0 ? Number((agreement / total).toFixed(4)) : 0,
      avgLatencyDeltaMs: avgLatencyRow?.avg_lat ? Number(avgLatencyRow.avg_lat.toFixed(2)) : 0,
      tierDistribution,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
