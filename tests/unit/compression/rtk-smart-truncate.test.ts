import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { smartTruncate } from "../../../open-sse/services/compression/engines/rtk/smartTruncate.ts";

describe("RTK smart truncate", () => {
  it("leaves short text unchanged", () => {
    const result = smartTruncate("short\ntext", { maxLines: 10 });
    assert.equal(result.truncated, false);
    assert.equal(result.text, "short\ntext");
  });

  it("preserves head, tail and priority lines", () => {
    const text = Array.from({ length: 20 }, (_, index) =>
      index === 10 ? "ERROR important failure" : `line ${index}`
    ).join("\n");
    const result = smartTruncate(text, {
      maxLines: 8,
      preserveHead: 2,
      preserveTail: 2,
      priorityPatterns: [/ERROR/],
    });

    assert.equal(result.truncated, true);
    assert.ok(result.text.includes("line 0"));
    assert.ok(result.text.includes("ERROR important failure"));
    assert.ok(result.text.includes("line 19"));
    assert.ok(result.text.includes("[rtk:truncated"));
  });

  it("respects maxChars as alternate limit", () => {
    const result = smartTruncate("x".repeat(500), { maxChars: 80 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 80);
  });

  it("respects maxChars when the marker consumes the full char budget", () => {
    const result = smartTruncate("x".repeat(500), { maxChars: 10 });

    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 10);
  });

  it("preserves same text at multiple indices independently (index-based selection)", () => {
    const text = [
      "WARN: deprecated API",
      "line 2",
      "WARN: deprecated API",
      "line 4",
      "WARN: deprecated API",
    ].join("\n");
    const result = smartTruncate(text, {
      maxLines: 3,
      preserveHead: 1,
      preserveTail: 1,
      priorityPatterns: [/WARN/],
    });
    assert.equal(result.truncated, true);
    const occurrences = result.text.split("WARN: deprecated API").length - 1;
    assert.equal(
      occurrences,
      3,
      "all three index-based occurrences preserved, not deduplicated by content"
    );
  });

  it("reserves budget for priority patterns under tight maxChars", () => {
    const text = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "ERROR failure",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
    ].join("\n");
    const result = smartTruncate(text, { maxChars: 60, maxLines: 5, priorityPatterns: [/ERROR/] });
    assert.equal(result.truncated, true);
    assert.ok(
      result.text.includes("ERROR failure"),
      "priority error line survives budget enforcement"
    );
    assert.ok(result.text.length <= 60, "result within exact char budget: " + result.text.length);
  });

  it("excludes non-selective patterns (hits > 50%) from forced budget", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i} file`).join("\n");
    // Force both line and char limits to trigger truncation; non-selective /file/ hits 100% of lines -> excluded from budget
    const result = smartTruncate(text, { maxChars: 50, maxLines: 3, priorityPatterns: [/file/] });
    assert.equal(result.truncated, true);
    // With /file/ excluded (hits*2 > lines), no middle forced lines; result should only contain head + tail + marker
    assert.ok(
      !result.text.includes("line 5 file"),
      "non-selective pattern excluded from forced budget; no middle lines forced"
    );
  });

  it("contains exactly one truncation marker", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const result = smartTruncate(text, { maxLines: 5, preserveHead: 2, preserveTail: 2 });
    assert.equal(result.truncated, true);
    const markers = result.text.split("[rtk:truncated").length - 1;
    assert.equal(markers, 1, "exactly one truncation marker inserted");
  });

  it("enforces final char-guard slice as strict ceiling", () => {
    const result = smartTruncate("x".repeat(500), { maxChars: 10 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 10, "final slice guard enforces strict char ceiling");
  });
});
