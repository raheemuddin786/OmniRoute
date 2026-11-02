/**
 * lib/projectScanner.ts — Local filesystem inspection for registered projects.
 *
 * Discovers project name, description, tech stack, cloud stack, files and docs
 * counts from the local workspace without external network calls.
 */

import fs from "fs";
import path from "path";

export interface ProjectScanResult {
  name: string;
  description: string;
  techStack: string[];
  cloudStack: string[];
  features: string[];
  filesCount: number;
  docsCount: number;
  memoryLocations: string[];
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
export function scanProjectDirectory(basePath: string): ProjectScanResult {
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
      description,
      techStack: ["Unknown"],
      cloudStack: [],
      features: [],
      filesCount: 0,
      docsCount: 0,
      memoryLocations: [],
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
    description,
    techStack: Array.from(techStack),
    cloudStack: Array.from(cloudStack),
    features: Array.from(features),
    filesCount,
    docsCount,
    memoryLocations,
  };
}
