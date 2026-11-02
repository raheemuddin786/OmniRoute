/**
 * lib/projectScanner.ts — Local filesystem inspection and workspace derivation.
 *
 * Discovers project name, description, tech stack, cloud stack, files and docs
 * counts from local workspace roots and derives active workspaces from proxy request
 * corpuses/logs and client session contexts without external network calls.
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
 * Normalizes and checks if a given directory path is a valid workspace root.
 * Validates existence, eliminates system/binary node directories (like .nvm, bin, lib),
 * and confirms presence of project descriptors.
 */
export function isValidWorkspaceRoot(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== "string") return false;
  try {
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved)) return false;
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) return false;

    // Filter out node version manager / runtime tool installations
    const lower = resolved.toLowerCase();
    if (
      lower.includes("/.nvm/") ||
      lower.includes("/.fnm/") ||
      lower.includes("/.asdf/") ||
      lower.includes("/node_modules") ||
      lower.endsWith("/bin")
    ) {
      return false;
    }

    // Must have at least one manifest, git directory, or workspace indicator
    return (
      fs.existsSync(path.join(resolved, "package.json")) ||
      fs.existsSync(path.join(resolved, "pyproject.toml")) ||
      fs.existsSync(path.join(resolved, "Cargo.toml")) ||
      fs.existsSync(path.join(resolved, "go.mod")) ||
      fs.existsSync(path.join(resolved, "pom.xml")) ||
      fs.existsSync(path.join(resolved, ".git")) ||
      fs.existsSync(path.join(resolved, "requirements.txt"))
    );
  } catch {
    return false;
  }
}

/**
 * Extracts candidate workspace root paths from headers, environment blocks, or request payloads.
 */
export function extractWorkspaceFromContext(
  headers?: Headers | Record<string, string | null | undefined> | null,
  body?: unknown
): string | null {
  // 1. Inspect headers
  if (headers) {
    const getHeader = (name: string): string | null => {
      if (typeof (headers as Headers).get === "function") {
        return (headers as Headers).get(name);
      }
      const record = headers as Record<string, string | null | undefined>;
      return record[name] || record[name.toLowerCase()] || null;
    };

    const headerCandidates = [
      getHeader("x-omniroute-workspace-root"),
      getHeader("x-project-path"),
      getHeader("x-workspace-root"),
      getHeader("x-claude-code-project-path"),
      getHeader("x-project-root"),
    ];

    for (const cand of headerCandidates) {
      if (cand && typeof cand === "string" && cand.trim().length > 0) {
        const clean = cand.trim();
        if (isValidWorkspaceRoot(clean)) {
          return path.resolve(clean);
        }
      }
    }
  }

  // 2. Inspect request body (e.g. Codex/Claude/Cursor environment blocks or metadata)
  if (body && typeof body === "object") {
    const bodyObj = body as Record<string, unknown>;

    // Look for explicit workspace/cwd in body
    if (typeof bodyObj.cwd === "string" && isValidWorkspaceRoot(bodyObj.cwd)) {
      return path.resolve(bodyObj.cwd);
    }
    if (typeof bodyObj.workspaceRoot === "string" && isValidWorkspaceRoot(bodyObj.workspaceRoot)) {
      return path.resolve(bodyObj.workspaceRoot);
    }

    // Inspect messages / system prompts for workspace_roots XML or working directory markers
    const messages = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const content = (msg as { content?: unknown }).content;
      if (typeof content === "string") {
        const rootMatch = content.match(/<root>([^<]+)<\/root>/);
        if (rootMatch && rootMatch[1] && isValidWorkspaceRoot(rootMatch[1])) {
          return path.resolve(rootMatch[1]);
        }
        const cwdMatch = content.match(/(?:working directory|cwd|workspace):\s*([/\\].+)/i);
        if (cwdMatch && cwdMatch[1]) {
          const cand = cwdMatch[1].trim().split(/\s+/)[0];
          if (cand && isValidWorkspaceRoot(cand)) {
            return path.resolve(cand);
          }
        }
      }
    }
  }

  return null;
}

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
    if (depth > 5 || filesCount > 25000) return;
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
 * 3. Sibling workspace directories under common development roots
 * 4. Extracted directory paths from request summaries/logs
 */
export function autoDiscoverWorkspaces(logSnippets: string[] = []): ProjectScanResult[] {
  const candidatePaths = new Set<string>();

  // 1. Current workspace root
  if (isValidWorkspaceRoot(process.cwd())) {
    candidatePaths.add(path.resolve(process.cwd()));
  }

  // 2. Active worktrees if present
  const worktreeDir = path.join(process.cwd(), ".claude", "worktrees");
  if (fs.existsSync(worktreeDir)) {
    try {
      const worktrees = fs.readdirSync(worktreeDir, { withFileTypes: true });
      for (const wt of worktrees) {
        if (wt.isDirectory()) {
          const wtPath = path.join(worktreeDir, wt.name);
          if (isValidWorkspaceRoot(wtPath)) {
            candidatePaths.add(path.resolve(wtPath));
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // 3. Check sibling development roots (up to 2 levels up if under 'work', 'dev', 'projects')
  try {
    const parentDir = path.dirname(process.cwd());
    const grandParentDir = path.dirname(parentDir);
    const checkDir = (dir: string) => {
      try {
        const siblings = fs.readdirSync(dir, { withFileTypes: true });
        for (const s of siblings) {
          if (s.isDirectory() && !s.name.startsWith(".")) {
            const sPath = path.join(dir, s.name);
            if (isValidWorkspaceRoot(sPath)) {
              candidatePaths.add(path.resolve(sPath));
            }
          }
        }
      } catch {
        // Ignore
      }
    };

    checkDir(parentDir);
    checkDir(grandParentDir);
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
        cleanPath = cleanPath.replace(/[,;:'")\]}]+$/, "");
        if (isValidWorkspaceRoot(cleanPath)) {
          candidatePaths.add(path.resolve(cleanPath));
        } else {
          // Walk up to find nearest valid workspace root
          let curr = path.dirname(cleanPath);
          for (let i = 0; i < 3; i++) {
            if (isValidWorkspaceRoot(curr)) {
              candidatePaths.add(path.resolve(curr));
              break;
            }
            const next = path.dirname(curr);
            if (next === curr) break;
            curr = next;
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
