/**
 * lib/projectScanner.ts — Local filesystem inspection and workspace derivation.
 *
 * Discovers project name, description, tech stack, cloud stack, files and docs
 * counts from local workspace roots and derives active workspaces from proxy request
 * corpuses/logs without external network calls.
 */

import fs from "fs";
import path from "path";

export interface ProjectScanResult {
  name: string;
  basePath: string;
  description: string;
  techStack: string[];
  cloudStack: string[];
  features: string[];
  filesCount: number;
  docsCount: number;
  memoryLocations: string[];
  provenance: "derived" | "manual";
}

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".cache",
  ".husky",
  "coverage",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

/**
 * Scans a project directory on the local filesystem.
 */
export function scanProjectDirectory(
  basePath: string,
  provenance: "derived" | "manual" = "derived"
): ProjectScanResult {
  const resolved = path.resolve(basePath);

  let name = path.basename(resolved);
  let description = "OmniRoute connected workspace";
  const techStack = new Set<string>();
  const cloudStack = new Set<string>();
  const features = new Set<string>();
  const memoryLocations: string[] = [];

  if (!fs.existsSync(resolved)) {
    return {
      name,
      basePath: resolved,
      description,
      techStack: ["Unknown"],
      cloudStack: [],
      features: [],
      filesCount: 0,
      docsCount: 0,
      memoryLocations: [],
      provenance,
    };
  }

  // 1. Inspect package.json
  const pkgPath = path.join(resolved, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        name = pkg.name;
      }
      if (typeof pkg.description === "string" && pkg.description.trim()) {
        description = pkg.description;
      }
      techStack.add("Node.js");
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) techStack.add("Next.js");
      if (deps.react) techStack.add("React");
      if (deps.typescript) techStack.add("TypeScript");
      if (deps.tailwindcss) techStack.add("Tailwind CSS");
      if (deps.electron) techStack.add("Electron");
      if (deps.better_sqlite3 || deps["better-sqlite3"]) techStack.add("SQLite");
      if (deps.vitest || deps.jest) techStack.add("Vitest / Jest");
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Inspect Python, Rust, Go, etc.
  if (
    fs.existsSync(path.join(resolved, "requirements.txt")) ||
    fs.existsSync(path.join(resolved, "pyproject.toml"))
  ) {
    techStack.add("Python");
  }
  if (fs.existsSync(path.join(resolved, "Cargo.toml"))) {
    techStack.add("Rust");
  }
  if (fs.existsSync(path.join(resolved, "go.mod"))) {
    techStack.add("Go");
  }

  // 3. Inspect Cloud stack
  if (fs.existsSync(path.join(resolved, "Dockerfile"))) {
    cloudStack.add("Docker");
  }
  if (fs.existsSync(path.join(resolved, "fly.toml"))) {
    cloudStack.add("Fly.io");
  }
  if (
    fs.existsSync(path.join(resolved, "docker-compose.yml")) ||
    fs.existsSync(path.join(resolved, "docker-compose.yaml"))
  ) {
    cloudStack.add("Docker Compose");
  }
  if (fs.existsSync(path.join(resolved, ".github", "workflows"))) {
    cloudStack.add("GitHub Actions");
  }

  // 4. Inspect Memory & Features
  if (fs.existsSync(path.join(resolved, "_tasks"))) {
    memoryLocations.push(path.join(resolved, "_tasks"));
    features.add("Private Task Memory");
  }
  if (fs.existsSync(path.join(resolved, "docs"))) {
    memoryLocations.push(path.join(resolved, "docs"));
    features.add("Documentation Corpus");
  }
  if (fs.existsSync(path.join(resolved, "open-sse"))) {
    features.add("SSE Streaming Engine");
  }

  // 5. Count files & docs (capped traversal for speed & stability)
  let filesCount = 0;
  let docsCount = 0;

  function traverse(dir: string, depth = 0) {
    if (depth > 5 || filesCount > 20000) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (entry.isDirectory()) {
          if (!EXCLUDE_DIRS.has(entry.name)) {
            traverse(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          filesCount++;
          const ext = path.extname(entry.name).toLowerCase();
          if (DOC_EXTENSIONS.has(ext)) {
            docsCount++;
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  traverse(resolved);

  return {
    name,
    basePath: resolved,
    description,
    techStack: Array.from(techStack),
    cloudStack: Array.from(cloudStack),
    features: Array.from(features),
    filesCount,
    docsCount,
    memoryLocations,
    provenance,
  };
}

/**
 * Automatically derives candidate project workspaces from:
 * 1. Current working directory
 * 2. Active worktrees under .claude/worktrees
 * 3. Sibling workspace directories
 * 4. Extracted directory paths from request summaries/logs
 */
export function autoDiscoverWorkspaces(logSnippets: string[] = []): ProjectScanResult[] {
  const candidatePaths = new Set<string>();

  // 1. Current workspace root
  candidatePaths.add(process.cwd());

  // 2. Active worktrees if present
  const worktreeDir = path.join(process.cwd(), ".claude", "worktrees");
  if (fs.existsSync(worktreeDir)) {
    try {
      const worktrees = fs.readdirSync(worktreeDir, { withFileTypes: true });
      for (const wt of worktrees) {
        if (wt.isDirectory()) {
          candidatePaths.add(path.join(worktreeDir, wt.name));
        }
      }
    } catch {
      // Ignore
    }
  }

  // 3. Check sibling development roots (up to 1 level up if under 'work' or 'dev')
  try {
    const parentDir = path.dirname(process.cwd());
    const grandParentDir = path.dirname(parentDir);
    const parentName = path.basename(parentDir).toLowerCase();
    if (parentName === "work" || parentName === "dev" || parentName === "tools") {
      const siblings = fs.readdirSync(parentDir, { withFileTypes: true });
      for (const s of siblings) {
        if (s.isDirectory() && !s.name.startsWith(".")) {
          const sPath = path.join(parentDir, s.name);
          if (
            fs.existsSync(path.join(sPath, "package.json")) ||
            fs.existsSync(path.join(sPath, ".git"))
          ) {
            candidatePaths.add(sPath);
          }
        }
      }
    } else {
      // Check grandparent for sibling clusters (e.g. /Users/raheem/work/...)
      const grandParentName = path.basename(grandParentDir).toLowerCase();
      if (grandParentName === "work" || grandParentName === "dev") {
        const grandSiblings = fs.readdirSync(grandParentDir, { withFileTypes: true });
        for (const gs of grandSiblings) {
          if (gs.isDirectory() && !gs.name.startsWith(".")) {
            const gsPath = path.join(grandParentDir, gs.name);
            if (
              fs.existsSync(path.join(gsPath, "package.json")) ||
              fs.existsSync(path.join(gsPath, ".git"))
            ) {
              candidatePaths.add(gsPath);
            }
          }
        }
      }
    }
  } catch {
    // Ignore
  }

  // 4. Extract paths from proxy request logs / summaries
  const pathRegex = /(?:\/Users|\/home|[a-zA-Z]:\\)[\w\-./\\]+/g;
  for (const snippet of logSnippets) {
    if (!snippet || typeof snippet !== "string") continue;
    const matches = snippet.match(pathRegex);
    if (matches) {
      for (const rawMatch of matches) {
        let cleanPath = rawMatch.trim();
        // Remove trailing punctuation
        cleanPath = cleanPath.replace(/[,;:'")\]}]+$/, "");
        if (fs.existsSync(cleanPath)) {
          const stats = fs.statSync(cleanPath);
          const dir = stats.isDirectory() ? cleanPath : path.dirname(cleanPath);
          if (
            fs.existsSync(path.join(dir, "package.json")) ||
            fs.existsSync(path.join(dir, ".git"))
          ) {
            candidatePaths.add(dir);
          }
        }
      }
    }
  }

  const results: ProjectScanResult[] = [];
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      results.push(scanProjectDirectory(candidate, "derived"));
    }
  }

  return results;
}
