import { z } from "zod";

import {
  getConfiguredLocalCorpusStatus,
  readConfiguredLocalCorpus,
  searchConfiguredLocalCorpus,
} from "../../../src/lib/localCorpus/configured.ts";

export const localCorpusTools = [
  {
    name: "local_corpus_status",
    description:
      "Show whether the read-only local corpus is configured and summarize its in-memory index.",
    scopes: ["read:local-corpus"],
    inputSchema: z
      .object({
        absoluteRootPath: z
          .string()
          .optional()
          .describe("Optional absolute path to override the globally configured root"),
      })
      .strict(),
    handler: async (args: { absoluteRootPath?: string }) =>
      getConfiguredLocalCorpusStatus(args.absoluteRootPath),
  },
  {
    name: "local_corpus_search",
    description:
      "Search text files under the local corpus root. The index refreshes incrementally and returns relative paths with line-scoped snippets.",
    scopes: ["read:local-corpus"],
    inputSchema: z
      .object({
        query: z.string().trim().min(1).max(500).describe("Text to search for"),
        limit: z.number().int().min(1).max(20).default(10).describe("Maximum results"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Force an incremental rescan before searching"),
        absoluteRootPath: z
          .string()
          .optional()
          .describe("Optional absolute path to override the globally configured root"),
      })
      .strict(),
    handler: async (args: {
      query: string;
      limit?: number;
      refresh?: boolean;
      absoluteRootPath?: string;
    }) =>
      searchConfiguredLocalCorpus(args.query, {
        limit: args.limit,
        refresh: args.refresh,
        rootPath: args.absoluteRootPath,
      }),
  },
  {
    name: "local_corpus_read",
    description:
      "Read a bounded line range from a permitted text file under the local corpus root.",
    scopes: ["read:local-corpus"],
    inputSchema: z
      .object({
        relativePath: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .describe("Path relative to the corpus root"),
        startLine: z.number().int().min(1).optional().describe("First line to return (1-based)"),
        endLine: z.number().int().min(1).optional().describe("Last line to return (inclusive)"),
        absoluteRootPath: z
          .string()
          .optional()
          .describe("Optional absolute path to override the globally configured root"),
      })
      .strict(),
    handler: async (args: {
      relativePath: string;
      startLine?: number;
      endLine?: number;
      absoluteRootPath?: string;
    }) =>
      readConfiguredLocalCorpus(args.relativePath, {
        startLine: args.startLine,
        endLine: args.endLine,
        rootPath: args.absoluteRootPath,
      }),
  },
] as const;
