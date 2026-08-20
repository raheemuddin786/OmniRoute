/**
 * searchTools — pure lexical scoring over tool names + descriptions.
 *
 * Anti-ReDoS: never compiles `new RegExp(query)`.
 * Uses only `String.prototype.indexOf` loops (same pattern as
 * `src/lib/memory/retrieval.ts::getRelevanceScore`).
 */

export interface ToolCatalogEntry {
  name: string;
  description: string;
  scopes: readonly string[];
  inputSchema?: unknown;
}

export interface ScoredTool {
  name: string;
  description: string;
  scopes: readonly string[];
  inputSchema?: unknown;
  score: number;
}

const EXACT_NAME_BONUS = 100;
const NAME_PHRASE_BONUS = 25;
const NAME_TOKEN_BONUS = 6;
const DESC_PHRASE_BONUS = 20;
const DESC_TOKEN_BONUS = 3;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function normalizeQueryString(query: string): {
  normalizedQuery: string;
  strippedQuery: string;
  tokens: string[];
} {
  const normalizedQuery = query.trim().toLowerCase();
  // Strip client prefixes like mcp_, mcp-, mcp:
  const strippedQuery = normalizedQuery.replace(/^(mcp[_-]|mcp:)/, "");

  const rawTokens = normalizedQuery.split(/[_\-:\s]+/).filter(Boolean);
  const strippedTokens = strippedQuery.split(/[_\-:\s]+/).filter(Boolean);

  const tokensSet = new Set<string>();
  for (const t of [...rawTokens, ...strippedTokens]) {
    if (t !== "mcp" && t.length > 0) {
      tokensSet.add(t);
    }
  }

  return {
    normalizedQuery,
    strippedQuery,
    tokens: Array.from(tokensSet),
  };
}

function scoreEntry(
  entry: ToolCatalogEntry,
  normalizedQuery: string,
  strippedQuery: string,
  tokens: string[]
): number {
  const nameLower = entry.name.toLowerCase();
  const descLower = entry.description.toLowerCase();

  let score = 0;

  // 1. Exact Name Match (Highest priority boost)
  if (nameLower === normalizedQuery || (strippedQuery && nameLower === strippedQuery)) {
    score += EXACT_NAME_BONUS;
  }

  // 2. Name phrase scoring
  if (nameLower.includes(normalizedQuery) || (strippedQuery && nameLower.includes(strippedQuery))) {
    score += NAME_PHRASE_BONUS;
  }

  // 3. Name token scoring
  for (const token of tokens) {
    score += countOccurrences(nameLower, token) * NAME_TOKEN_BONUS;
  }

  // 4. Description phrase scoring
  if (descLower.includes(normalizedQuery) || (strippedQuery && descLower.includes(strippedQuery))) {
    score += DESC_PHRASE_BONUS;
  }

  // 5. Description token scoring
  for (const token of tokens) {
    score += countOccurrences(descLower, token) * DESC_TOKEN_BONUS;
  }

  return score;
}

/**
 * Search tool catalog entries lexically (no RegExp on user input).
 * Returns top-K results ordered by score desc, name asc for ties.
 */
export function searchTools(entries: ToolCatalogEntry[], query: string, limit = 8): ScoredTool[] {
  const clampedLimit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, limit));
  const { normalizedQuery, strippedQuery, tokens } = normalizeQueryString(query);
  if (!normalizedQuery && !strippedQuery) return [];

  const scored: ScoredTool[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, normalizedQuery, strippedQuery, tokens);
    if (score > 0) {
      scored.push({ ...entry, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return scored.slice(0, clampedLimit);
}
