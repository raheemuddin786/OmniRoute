import path from "node:path";
import { getLocalCorpusRoot } from "../db/localCorpus";
import { getDefaultLocalCorpusStatus, LocalCorpusIndex } from "./index";

const indexCache = new Map<string, LocalCorpusIndex>();

export function resetLocalCorpusIndex(): void {
  indexCache.clear();
}

function getConfiguredIndex(dynamicRoot?: string): LocalCorpusIndex {
  const dbRoot = getLocalCorpusRoot();
  let finalRoot = dynamicRoot || dbRoot;

  if (!finalRoot) {
    throw new Error(
      "Local corpus is not configured. Pass absoluteRootPath or set a root in Settings > Context Sources"
    );
  }

  // Security: Prevent path traversal by ensuring dynamic root is bounded
  const boundingBox = dbRoot ? path.resolve(dbRoot) : process.cwd();
  if (dynamicRoot) {
    const resolvedDynamic = path.resolve(dynamicRoot);
    if (!resolvedDynamic.startsWith(boundingBox)) {
      throw new Error(
        `Path traversal forbidden: requested path ${resolvedDynamic} is outside allowed boundary ${boundingBox}`
      );
    }
  }

  const resolvedRoot = path.resolve(finalRoot);

  if (!indexCache.has(resolvedRoot)) {
    // Simple LRU: if map is too large, evict the oldest entry
    if (indexCache.size >= 5) {
      const firstKey = indexCache.keys().next().value;
      if (firstKey) indexCache.delete(firstKey);
    }
    indexCache.set(resolvedRoot, new LocalCorpusIndex(resolvedRoot));
  }

  return indexCache.get(resolvedRoot)!;
}

export function getConfiguredLocalCorpusStatus(dynamicRoot?: string) {
  try {
    return getConfiguredIndex(dynamicRoot).getStatus();
  } catch (err) {
    if (err instanceof Error && err.message.includes("is not configured")) {
      return getDefaultLocalCorpusStatus();
    }
    throw err;
  }
}

export async function searchConfiguredLocalCorpus(
  query: string,
  options: { limit?: number; refresh?: boolean; rootPath?: string } = {}
) {
  return getConfiguredIndex(options.rootPath).search(query, options);
}

export async function readConfiguredLocalCorpus(
  relativePath: string,
  options: { startLine?: number; endLine?: number; rootPath?: string } = {}
) {
  return getConfiguredIndex(options.rootPath).read(relativePath, options);
}
