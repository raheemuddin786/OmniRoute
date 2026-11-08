import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createSessionConcurrencyGuard,
  type ConcurrentRequestToken,
} from "../../open-sse/handlers/chatCore/sessionConcurrencyGuard.ts";

describe("sessionConcurrencyGuard", () => {
  it("acquires and releases session concurrency lock successfully", async () => {
    const guard = createSessionConcurrencyGuard();
    const token = await guard.acquire("model-a", "test-provider", "conn-1", "session-123");

    assert.ok(token);
    assert.strictEqual(token.model, "model-a");
    assert.strictEqual(token.provider, "test-provider");
    assert.strictEqual(token.sessionId, "session-123");

    await guard.release(token);
  });

  it("blocks rapid successive requests to the same model within the same session (micro-burst throttle)", async () => {
    const guard = createSessionConcurrencyGuard();
    await guard.acquire("model-b", "test-provider", "conn-2", "session-456");

    let blocked = false;
    try {
      await guard.acquire("model-b", "test-provider", "conn-2", "session-456");
    } catch (err: unknown) {
      blocked = true;
      // The micro-burst throttle blocks rapid successive requests before model lock is attempted
      assert.strictEqual((err as Error).message.includes("sub_second_burst_throttled"), true);
    }

    assert.strictEqual(blocked, true);
    const mockToken: ConcurrentRequestToken = {
      model: "model-b",
      provider: "test-provider",
      connectionId: "conn-2",
      sessionId: "session-456",
      key: "",
      acquiredAt: 0,
      abort: async () => {},
    };
    await guard.release(mockToken);
  });

  it("allows second request after first releases its lock and inter-request gap passes", async () => {
    const guard = createSessionConcurrencyGuard();
    const token1 = await guard.acquire("model-c", "test-provider", "conn-3", "session-789");

    await guard.release(token1);

    // Wait for the minimum inter-request gap (45ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    const token2 = await guard.acquire("model-c", "test-provider", "conn-3", "session-789");
    assert.ok(token2);

    await guard.release(token2);
  });
});
