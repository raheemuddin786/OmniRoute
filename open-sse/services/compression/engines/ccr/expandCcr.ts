/**
 * Ingress expansion and hydration for CCR (Content-Compression-Retrieve) markers (#14800).
 *
 * Automatically detects and hydrates content-addressed markers:
 *   `[CCR retrieve hash=<24hex> chars=<N>]`
 * from both the in-memory CCR store and the durable SQLite store (ccr_blocks).
 *
 * Ensures that upstream models (such as Claude Web or OpenAI models without direct
 * MCP access) receive full, uncorrupted prompts even when client sessions replay
 * compressed conversation history.
 */

import { loadCcrBlockContent } from "../../../../../src/lib/db/ccrBlocks";

const CCR_MARKER_REGEX = /(?:[^\n\r]*…\s*)?\[CCR retrieve hash=([a-f0-9]{24})(?:\s+chars=\d+)?\]/g;

const SPB_DIRECTIVE_CLEANUP_REGEX = /\[SPB-IR (?:Apex|Resilient|Local) Directive:[^\]]+\]\n*/g;

const SPB_COMPLETION_CLEANUP_REGEX = /\n*\[Completion Standard:[^\]]+\]/g;

/**
 * Resolves content for a 24-character hexadecimal CCR hash.
 * Checks SQLite durable database (ccr_blocks).
 */
export function resolveCcrContent(hash: string, principalId?: string): string | null {
  if (!hash || typeof hash !== "string") return null;

  try {
    return loadCcrBlockContent(hash, principalId);
  } catch {
    return null;
  }
}

/**
 * Expands all CCR markers in a text string back to their full verbatim content.
 */
export function expandTextCcrMarkers(text: string, principalId?: string): string {
  if (!text || typeof text !== "string" || !text.includes("CCR retrieve")) {
    return text;
  }

  return text.replace(CCR_MARKER_REGEX, (match, hash: string) => {
    const content = resolveCcrContent(hash, principalId);
    return content !== null ? content : match;
  });
}

/**
 * Strips legacy pseudo-system bracket headers that trigger safety/prompt-injection filters.
 */
export function cleanSpbDirectives(text: string): string {
  if (!text || typeof text !== "string") return text;
  let cleaned = text;
  if (cleaned.includes("SPB-IR")) {
    cleaned = cleaned.replace(SPB_DIRECTIVE_CLEANUP_REGEX, "");
  }
  if (cleaned.includes("Completion Standard")) {
    cleaned = cleaned.replace(SPB_COMPLETION_CLEANUP_REGEX, "");
  }
  return cleaned;
}

/**
 * Detects if a text block contains stringified JSON of array of text parts
 * (produced by previous stringification) and extracts the natural text.
 */
export function tryUnwrapStringifiedJsonText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("[{") && trimmed.endsWith("}]") && trimmed.includes('"type"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (p): p is { type: string; text: string } =>
            typeof p === "object" &&
            p !== null &&
            "type" in p &&
            (p as { type: unknown }).type === "text" &&
            "text" in p &&
            typeof (p as { text: unknown }).text === "string"
        )
      ) {
        return parsed.map((p) => p.text).join("\n\n");
      }
    } catch {
      // Not JSON or parse error, keep as is
    }
  }
  return text;
}

export type IngressMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

/**
 * Recursively hydrates all CCR markers in an incoming messages array.
 */
export function expandIncomingCcrMarkers<T extends IngressMessage[]>(
  messages: T,
  principalId?: string
): T {
  if (!Array.isArray(messages)) return messages;

  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;

    if (typeof msg.content === "string") {
      let content = msg.content;
      if (content.includes("CCR retrieve")) {
        content = expandTextCcrMarkers(content, principalId);
      }
      content = cleanSpbDirectives(content);
      content = tryUnwrapStringifiedJsonText(content);
      return { ...msg, content };
    }

    if (Array.isArray(msg.content)) {
      const updatedParts = (msg.content as unknown[]).map((part) => {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: unknown }).type === "text" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
        ) {
          let text = (part as { text: string }).text;
          if (text.includes("CCR retrieve")) {
            text = expandTextCcrMarkers(text, principalId);
          }
          text = cleanSpbDirectives(text);
          return { ...(part as Record<string, unknown>), text };
        }
        return part;
      });
      return { ...msg, content: updatedParts };
    }

    return msg;
  }) as T;
}
