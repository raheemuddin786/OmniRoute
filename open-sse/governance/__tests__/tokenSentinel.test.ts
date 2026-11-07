import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  TokenSentinelTracker,
  extractReasoningText,
  resolveGovernanceReasoningCeiling,
  createTokenSentinelTracker,
  releaseTokenSentinelTracker,
  liveTokenSentinelCount,
  releaseAllTokenSentinelTrackers,
  detectDegenerateRepetition,
  resolveGovernanceDegenerateRepetitionEnabled,
  resolveGovernanceRepetitionRunawayThreshold,
  resolveGovernanceRepetitionStutterThreshold,
  resolveGovernanceRepetitionPhraseCycles,
  DEFAULT_REASONING_TOKEN_CEILING,
  CHARS_PER_TOKEN,
} from "../tokenSentinel.ts";

describe("token sentinel", () => {
  describe("cumulative ceiling", () => {
    it("does not breach below the ceiling", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 100 });
      expect(tracker.observeReasoningText("a".repeat(40))).toBeNull();
      expect(tracker.cumulative).toBe(10);
    });

    it("breaches at the ceiling", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 100 });
      // 40 chars ≈ 10 tokens — well below the ceiling.
      expect(tracker.observeReasoningText("a".repeat(40))).toBeNull();
      const breach = tracker.observeReasoningText("a".repeat(400));
      expect(breach).not.toBeNull();
      expect(breach?.kind).toBe("ceiling");
      expect(breach?.limit).toBe(100);
      expect(breach?.cumulativeTokens).toBeGreaterThanOrEqual(100);
    });

    it("reports at most ONE breach per stream", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 10 });
      expect(tracker.observeReasoningText("a".repeat(100))).not.toBeNull();
      expect(tracker.observeReasoningText("a".repeat(100))).toBeNull();
      expect(tracker.didBreach).toBe(true);
    });

    it("estimates tokens at roughly four characters each", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 10_000 });
      tracker.observeReasoningText("a".repeat(40));
      expect(tracker.cumulative).toBe(40 / CHARS_PER_TOKEN);
    });

    it("ignores empty text", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 10 });
      expect(tracker.observeReasoningText("")).toBeNull();
      expect(tracker.cumulative).toBe(0);
    });

    it("counts whitespace as content (it is still emitted tokens)", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 10 });
      expect(tracker.observeReasoningText("   ")).toBeNull();
      expect(tracker.cumulative).toBe(1);
    });
  });

  describe("velocity ceiling", () => {
    it("does not fire when the velocity ceiling is disabled", () => {
      const tracker = new TokenSentinelTracker({ ceiling: 1_000_000, velocityCeiling: null });
      expect(tracker.observeReasoningText("a".repeat(4000))).toBeNull();
    });

    it("fires when the burst exceeds the velocity ceiling", () => {
      let now = 1_000;
      const tracker = new TokenSentinelTracker({
        ceiling: 1_000_000,
        velocityCeiling: 10,
        velocityWindowMs: 2_000,
        now: () => now,
      });
      now += 1;
      const breach = tracker.observeReasoningText("a".repeat(4000));
      expect(breach).not.toBeNull();
      expect(breach?.kind).toBe("velocity");
    });
  });

  describe("reasoning extraction", () => {
    it("reads the OpenAI Chat `delta.reasoning_content`", () => {
      const texts = extractReasoningText({
        choices: [{ delta: { reasoning_content: "thinking..." } }],
      });
      expect(texts).toEqual(["thinking..."]);
    });

    it("reads the `reasoning_text` and `reasoning` aliases", () => {
      expect(extractReasoningText({ choices: [{ delta: { reasoning_text: "a" } }] })).toEqual([
        "a",
      ]);
      expect(extractReasoningText({ choices: [{ delta: { reasoning: "b" } }] })).toEqual(["b"]);
    });

    it("reads the Anthropic `delta.thinking`", () => {
      expect(
        extractReasoningText({ type: "content_block_delta", delta: { thinking: "hmm" } })
      ).toEqual(["hmm"]);
    });

    it("reads the Anthropic `content_block.thinking`", () => {
      expect(
        extractReasoningText({
          type: "content_block_start",
          content_block: { type: "thinking", thinking: "x" },
        })
      ).toEqual(["x"]);
    });

    it("reads the `reasoning_details[]` array form", () => {
      const texts = extractReasoningText({
        choices: [{ delta: { reasoning_details: [{ text: "d1" }, "d2"] } }],
      });
      expect(texts).toEqual(["d1", "d2"]);
    });

    it("reads the Responses `response.reasoning_content_text.delta`", () => {
      expect(
        extractReasoningText({ type: "response.reasoning_content_text.delta", delta: "r" })
      ).toEqual(["r"]);
    });

    it("ignores a Responses event whose type is not reasoning", () => {
      expect(extractReasoningText({ type: "response.output_text.delta", delta: "r" })).toEqual([]);
    });

    it("returns an empty list for a non-object payload", () => {
      expect(extractReasoningText(null)).toEqual([]);
      expect(extractReasoningText("x")).toEqual([]);
    });
  });

  describe("ceiling configuration", () => {
    const original = process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;

    afterEach(() => {
      if (original === undefined) delete process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;
      else process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = original;
    });

    it("falls back to the default when the env var is absent", () => {
      delete process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;
      expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
    });

    it("honours a positive integer override", () => {
      process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "500";
      expect(resolveGovernanceReasoningCeiling()).toBe(500);
    });

    it("ignores a non-numeric, zero or negative override", () => {
      for (const raw of ["abc", "0", "-10"]) {
        process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = raw;
        expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
      }
    });
  });

  describe("tracker lifecycle", () => {
    beforeEach(() => {
      releaseAllTokenSentinelTrackers();
    });

    afterEach(() => {
      releaseAllTokenSentinelTrackers();
    });

    it("tracks live trackers so a leak is observable", () => {
      const before = liveTokenSentinelCount();
      const tracker = createTokenSentinelTracker();
      expect(liveTokenSentinelCount()).toBe(before + 1);
      releaseTokenSentinelTracker(tracker);
      expect(liveTokenSentinelCount()).toBe(before);
    });

    it("is idempotent on a double release", () => {
      const tracker = createTokenSentinelTracker();
      expect(releaseTokenSentinelTracker(tracker)).toBe(true);
      expect(releaseTokenSentinelTracker(tracker)).toBe(false);
    });

    it("tolerates a null tracker", () => {
      expect(releaseTokenSentinelTracker(null)).toBe(false);
      expect(releaseTokenSentinelTracker(undefined)).toBe(false);
    });

    it("marks the tracker released", () => {
      const tracker = createTokenSentinelTracker();
      expect(tracker.isReleased).toBe(false);
      releaseTokenSentinelTracker(tracker);
      expect(tracker.isReleased).toBe(true);
    });
  });
});

describe("token sentinel — mid-stream disconnect", () => {
  beforeEach(() => {
    releaseAllTokenSentinelTrackers();
  });

  afterEach(() => {
    releaseAllTokenSentinelTrackers();
  });

  it("does NOT leak a tracker when the client disconnects mid-stream", () => {
    const before = liveTokenSentinelCount();
    const tracker = createTokenSentinelTracker();

    // The stream ran for a while, then the client went away.
    tracker.observeReasoningText("thinking about it");
    tracker.observeReasoningText("still thinking");

    // The abort path releases the tracker (the same call the streaming tail
    // makes on `streamController.signal`).
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      releaseTokenSentinelTracker(tracker);
    });
    abortController.abort();

    expect(liveTokenSentinelCount()).toBe(before);
    expect(tracker.isReleased).toBe(true);
  });

  it("keeps the live count stable across many connect/disconnect cycles", () => {
    const before = liveTokenSentinelCount();
    for (let i = 0; i < 25; i++) {
      const tracker = createTokenSentinelTracker();
      tracker.observeReasoningText("x");
      releaseTokenSentinelTracker(tracker);
    }
    expect(liveTokenSentinelCount()).toBe(before);
  });

  it("reports a released tracker as not observing any further reasoning", () => {
    const tracker = createTokenSentinelTracker({ ceiling: 1 });
    releaseTokenSentinelTracker(tracker);
    // A released tracker must not resurrect a breach after the stream ended.
    expect(tracker.observeReasoningText("x".repeat(100))).toBeNull();
  });
});

describe("resolveGovernanceReasoningCeiling", () => {
  const originalEnv = process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = originalEnv;
    } else {
      delete process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;
    }
  });

  it("returns DEFAULT_REASONING_TOKEN_CEILING when env var is undefined", () => {
    delete process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING;
    expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
  });

  it("returns DEFAULT_REASONING_TOKEN_CEILING when env var is empty string", () => {
    process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "";
    expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
  });

  it("returns DEFAULT_REASONING_TOKEN_CEILING when env var is non-numeric string", () => {
    process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "invalid_ceiling";
    expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
  });

  it("returns DEFAULT_REASONING_TOKEN_CEILING when env var is zero or negative", () => {
    process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "0";
    expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);

    process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "-500";
    expect(resolveGovernanceReasoningCeiling()).toBe(DEFAULT_REASONING_TOKEN_CEILING);
  });

  it("parses and returns valid positive integer", () => {
    process.env.OMNIROUTE_GOVERNANCE_REASONING_TOKEN_CEILING = "32000";
    expect(resolveGovernanceReasoningCeiling()).toBe(32_000);
  });
});

describe("detectDegenerateRepetition", () => {
  const originalEnabled = process.env.OMNIROUTE_GOVERNANCE_DEGENERATE_REPETITION_ENABLED;
  const originalRunaway = process.env.OMNIROUTE_GOVERNANCE_REPETITION_RUNAWAY_THRESHOLD;
  const originalStutter = process.env.OMNIROUTE_GOVERNANCE_REPETITION_STUTTER_THRESHOLD;
  const originalPhrase = process.env.OMNIROUTE_GOVERNANCE_REPETITION_PHRASE_CYCLES;

  afterEach(() => {
    if (originalEnabled === undefined)
      delete process.env.OMNIROUTE_GOVERNANCE_DEGENERATE_REPETITION_ENABLED;
    else process.env.OMNIROUTE_GOVERNANCE_DEGENERATE_REPETITION_ENABLED = originalEnabled;
    if (originalRunaway === undefined)
      delete process.env.OMNIROUTE_GOVERNANCE_REPETITION_RUNAWAY_THRESHOLD;
    else process.env.OMNIROUTE_GOVERNANCE_REPETITION_RUNAWAY_THRESHOLD = originalRunaway;
    if (originalStutter === undefined)
      delete process.env.OMNIROUTE_GOVERNANCE_REPETITION_STUTTER_THRESHOLD;
    else process.env.OMNIROUTE_GOVERNANCE_REPETITION_STUTTER_THRESHOLD = originalStutter;
    if (originalPhrase === undefined)
      delete process.env.OMNIROUTE_GOVERNANCE_REPETITION_PHRASE_CYCLES;
    else process.env.OMNIROUTE_GOVERNANCE_REPETITION_PHRASE_CYCLES = originalPhrase;
  });

  it("detects genuine consecutive word-level stuttering", () => {
    const text = "Google's Google's recommended recommended snippet snippet is is always always ";
    const res = detectDegenerateRepetition(text);
    expect(res.detected).toBe(true);
    expect(res.reason).toContain("word_stuttering");
  });

  it("does NOT false-positive on words scattered across normal code, sentences, or JSON", () => {
    const code = `
      const item = { type: type, status: status, value: value };
      const other = { type: type, status: status, value: value };
      return true;
    `;
    const res = detectDegenerateRepetition(code);
    expect(res.detected).toBe(false);
  });

  it("does NOT false-positive on structured Markdown tables and bulleted lists", () => {
    const tableAndList = `
      | Step | Status | Evidence |
      | --- | --- | --- |
      | GAP-001 | Complete and verified | routes/web.php tested |
      | GAP-002 | Complete and verified | routes/api.php tested |
      | GAP-003 | Complete and verified | routes/console.php tested |
      - Phase 1: locate_root and read_docs
      - Phase 2: locate_root and read_docs
      - Phase 3: locate_root and read_docs
    `;
    const res = detectDegenerateRepetition(tableAndList);
    expect(res.detected).toBe(false);
  });

  it("detects runaway single-word repetition", () => {
    const text = "wait wait wait wait wait wait wait wait wait wait wait";
    const res = detectDegenerateRepetition(text, { isReasoning: true });
    expect(res.detected).toBe(true);
    expect(res.reason).toContain("runaway_word_repeat");
  });

  it("honours OMNIROUTE_GOVERNANCE_DEGENERATE_REPETITION_ENABLED=false", () => {
    process.env.OMNIROUTE_GOVERNANCE_DEGENERATE_REPETITION_ENABLED = "false";
    expect(resolveGovernanceDegenerateRepetitionEnabled()).toBe(false);
    const text = "wait wait wait wait wait wait wait wait wait wait wait";
    const res = detectDegenerateRepetition(text);
    expect(res.detected).toBe(false);
  });

  it("honours repetition threshold environment variable overrides", () => {
    process.env.OMNIROUTE_GOVERNANCE_REPETITION_RUNAWAY_THRESHOLD = "15";
    process.env.OMNIROUTE_GOVERNANCE_REPETITION_STUTTER_THRESHOLD = "10";
    process.env.OMNIROUTE_GOVERNANCE_REPETITION_PHRASE_CYCLES = "8";

    expect(resolveGovernanceRepetitionRunawayThreshold()).toBe(15);
    expect(resolveGovernanceRepetitionStutterThreshold()).toBe(10);
    expect(resolveGovernanceRepetitionPhraseCycles()).toBe(8);
  });

  it("allows disabling repetition via tracker options", () => {
    const tracker = new TokenSentinelTracker({ repetitionEnabled: false });
    const text = "wait wait wait wait wait wait wait wait wait wait wait";
    expect(tracker.observeText(text)).toBeNull();
  });
});
