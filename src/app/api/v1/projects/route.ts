import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { listProjects, insertProject, getProjectByBasePath } from "@/lib/db/projectRegistry";
import { scanProjectDirectory } from "@/lib/projectScanner";
import { randomUUID } from "crypto";

// Auto-seed current project if registry is empty
function ensureCurrentProjectSeeded() {
  const currentPath = process.cwd();
  const existing = getProjectByBasePath(currentPath);
  if (!existing) {
    const scan = scanProjectDirectory(currentPath);
    const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    insertProject(
      id,
      scan.name || "OmniRoute",
      currentPath,
      scan.description,
      scan.techStack,
      scan.cloudStack,
      scan.features,
      scan.filesCount,
      scan.docsCount,
      "active",
      scan.memoryLocations
    );
  }
}

// GET /api/v1/projects — List all connected projects
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    ensureCurrentProjectSeeded();
    const projects = listProjects();
    return NextResponse.json({
      success: true,
      projects,
      total: projects.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list projects" },
      { status: 500 }
    );
  }
}

// POST /api/v1/projects — Register a new project or scan an existing directory
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const basePath = typeof body.basePath === "string" ? body.basePath.trim() : "";

    if (!basePath) {
      return NextResponse.json(
        { success: false, error: "basePath is required to register a project" },
        { status: 400 }
      );
    }

    // Check if already registered
    const existing = getProjectByBasePath(basePath);
    if (existing) {
      return NextResponse.json({
        success: true,
        project: existing,
        message: "Project already registered",
      });
    }

    // Scan directory
    const scan = scanProjectDirectory(basePath);
    const id = `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const project = insertProject(
      id,
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : scan.name,
      basePath,
      typeof body.description === "string" ? body.description.trim() : scan.description,
      Array.isArray(body.techStack) ? body.techStack : scan.techStack,
      Array.isArray(body.cloudStack) ? body.cloudStack : scan.cloudStack,
      Array.isArray(body.features) ? body.features : scan.features,
      typeof body.filesCount === "number" ? body.filesCount : scan.filesCount,
      typeof body.docsCount === "number" ? body.docsCount : scan.docsCount,
      "active",
      Array.isArray(body.memoryLocations) ? body.memoryLocations : scan.memoryLocations
    );

    return NextResponse.json({
      success: true,
      project,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to register project",
      },
      { status: 500 }
    );
  }
}
