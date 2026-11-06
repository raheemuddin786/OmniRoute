import { parentPort } from "node:worker_threads";

import {
  writeCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";

type WriteRequest = {
  id: number;
  artifact: CallLogArtifact;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
    dataDir?: string;
  };
};

type WriteReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
};

/**
 * Resolves the data directory for the worker, with fallback handling for
 * cases where process.cwd() throws ENOENT (e.g., when the parent's working
 * directory was deleted). The dataDir is passed from the parent via the
 * environment message and takes precedence over cwd-based resolution.
 */
function resolveWorkerDataDir(requestDataDir: string | undefined): string {
  // Priority 1: explicit dataDir from parent (already resolved, won't throw)
  if (requestDataDir && requestDataDir.trim()) {
    return requestDataDir;
  }
  // Priority 2: process.cwd() with ENOENT fallback
  try {
    return process.cwd();
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // Last resort: use os.tmpdir() to avoid crashing the worker
      return require("os").tmpdir();
    }
    throw err;
  }
}

function applyWriteEnvironment(environment: WriteRequest["environment"]): void {
  const resolvedDataDir = resolveWorkerDataDir(environment.dataDir);
  const values = {
    CALL_LOG_PIPELINE_MAX_SIZE_KB: environment.pipelineMaxSizeKb,
    CHAT_DEBUG_FILE: environment.chatDebugFile,
    APP_LOG_LEVEL: environment.appLogLevel,
    // The worker resolves its paths lazily like the parent; pin it to the
    // parent's resolved dir so both executors share one target.
    DATA_DIR: resolvedDataDir,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

parentPort?.on("message", (request: WriteRequest) => {
  const originalConsoleError = console.error;
  let result: CallLogArtifactWriteResult | null = null;

  try {
    // The writer reads these options lazily; mirror the caller's per-write environment snapshot.
    applyWriteEnvironment(request.environment);
    // writeCallArtifact's legacy error includes filesystem paths. Keep worker failures generic.
    console.error = () => {};
    result = writeCallArtifact(request.artifact);
  } catch {
    result = null;
  } finally {
    console.error = originalConsoleError;
  }

  try {
    parentPort?.postMessage({ id: request.id, result } satisfies WriteReply);
  } catch {
    parentPort?.postMessage({ id: request.id, result: null } satisfies WriteReply);
  }
});
