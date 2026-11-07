import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { scanProjectDirectory } from "@/lib/projectScanner";

// POST /api/v1/projects/scan — Preview filesystem metadata for a given path
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const basePath = typeof body.basePath === "string" ? body.basePath.trim() : "";
    if (!basePath) {
      return NextResponse.json(
        { success: false, error: "basePath is required in the request body" },
        { status: 400 }
      );
    }

    const scan = scanProjectDirectory(basePath);
    return NextResponse.json({
      success: true,
      scan,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to scan directory",
      },
      { status: 500 }
    );
  }
}
