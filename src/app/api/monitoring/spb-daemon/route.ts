import { NextResponse } from "next/server";
import { getSpbRecoveryDaemon } from "@/lib/spbRecoveryDaemon";

export async function GET() {
  const daemon = getSpbRecoveryDaemon();
  const status = daemon.getStatus();
  const metrics = daemon.getMetrics();
  return NextResponse.json({ status, metrics });
}
