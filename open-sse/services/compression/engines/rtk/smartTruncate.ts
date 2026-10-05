export interface SmartTruncateOptions {
  maxLines?: number;
  maxChars?: number;
  preserveHead?: number;
  preserveTail?: number;
  priorityPatterns?: RegExp[];
}

export function smartTruncate(
  text: string,
  options: SmartTruncateOptions = {}
): {
  text: string;
  truncated: boolean;
  droppedLines: number;
} {
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? 0));
  const maxLines = Math.max(0, Math.floor(options.maxLines ?? 0));
  const lines = text.split(/\r?\n/);
  const overLineLimit = maxLines > 0 && lines.length > maxLines;
  const overCharLimit = maxChars > 0 && text.length > maxChars;
  if (!overLineLimit && !overCharLimit) {
    return { text, truncated: false, droppedLines: 0 };
  }

  const preserveHead = Math.max(0, Math.floor(options.preserveHead ?? 20));
  const preserveTail = Math.max(0, Math.floor(options.preserveTail ?? 20));
  const priorityPatterns = options.priorityPatterns ?? [];

  const selectedIndices = new Set<number>();

  // 1. Add head indices
  for (let i = 0; i < Math.min(preserveHead, lines.length); i++) {
    selectedIndices.add(i);
  }

  // 2. Add tail indices
  const tailStart = Math.max(0, lines.length - preserveTail);
  for (let i = tailStart; i < lines.length; i++) {
    selectedIndices.add(i);
  }

  // 3. Add priority lines by index
  if (priorityPatterns.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (priorityPatterns.some((pattern) => pattern.test(lines[i]))) {
        selectedIndices.add(i);
      }
    }
  }

  // Convert Set to sorted array of indices to strictly preserve original line order
  const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
  const droppedLines = Math.max(0, lines.length - sortedIndices.length);

  // Re-split into head vs remainder to place the EXACT single marker
  const headEndIdx = sortedIndices.findIndex((idx) => idx >= preserveHead);
  const splitIndex = headEndIdx === -1 ? sortedIndices.length : headEndIdx;

  const headLines = sortedIndices.slice(0, splitIndex).map((i) => lines[i]);
  const tailLines = sortedIndices.slice(splitIndex).map((i) => lines[i]);

  let result =
    droppedLines > 0
      ? [...headLines, `[rtk:truncated ${droppedLines} lines]`, ...tailLines].join("\n")
      : [...headLines, ...tailLines].join("\n");

  if (maxChars > 0 && result.length > maxChars) {
    const marker = "\n[rtk:truncated by chars]\n";
    const budget = Math.max(0, maxChars - marker.length);
    if (budget === 0) {
      result = marker.slice(0, maxChars);
      return { text: result, truncated: true, droppedLines };
    }
    const headChars = Math.ceil(budget * 0.55);
    const tailChars = Math.max(0, budget - headChars);
    const tailText = tailChars > 0 ? result.slice(-tailChars) : "";
    result = `${result.slice(0, headChars)}${marker}${tailText}`;
    if (result.length > maxChars) result = result.slice(0, maxChars);
  }

  return { text: result, truncated: true, droppedLines };
}
