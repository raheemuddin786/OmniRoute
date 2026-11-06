/**
 * shared/utils/promptExport.ts — Utilities for formatting and exporting prompt records
 * and session histories to JSON and CSV formats.
 */

export interface PromptExportRecord {
  prompt: string;
  systemPrompt?: string;
  timestamp: string;
  project?: string;
  model?: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  toolsUsed?: string[];
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Downloads a raw string content as a downloadable file via blob URL
 */
export function downloadFile(content: string, filename: string, mimeType: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Generates a formatted CSV string from prompt export records
 */
export function generatePromptsCSV(records: PromptExportRecord[]): string {
  const headers = [
    "Timestamp",
    "Prompt Text",
    "System Prompt",
    "Project",
    "Model",
    "Tokens In",
    "Tokens Out",
    "Estimated Cost (USD)",
    "Tools Used",
  ];

  const rows = records.map((r) => [
    csvEscape(r.timestamp),
    csvEscape(r.prompt),
    csvEscape(r.systemPrompt ?? ""),
    csvEscape(r.project ?? ""),
    csvEscape(r.model ?? ""),
    csvEscape(r.tokensIn ?? 0),
    csvEscape(r.tokensOut ?? 0),
    csvEscape(r.costUsd ? r.costUsd.toFixed(6) : "0.000000"),
    csvEscape(r.toolsUsed ? r.toolsUsed.join("; ") : "none"),
  ]);

  return [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

/**
 * Generates an indented JSON string from prompt records with metadata header
 */
export function generatePromptsJSON(
  records: PromptExportRecord[],
  metadata?: { projectName?: string; totalSessions?: number }
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      metadata: metadata ?? {},
      totalPrompts: records.length,
      prompts: records,
    },
    null,
    2
  );
}
