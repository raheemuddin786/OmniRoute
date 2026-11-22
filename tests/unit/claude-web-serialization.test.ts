import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeWebExecutor } from "../../open-sse/executors/claude-web.ts";
import { __setTlsFetchOverrideForTesting } from "../../open-sse/services/claudeTlsClient.ts";
import { resetAll as resetSemaphore } from "../../open-sse/services/accountSemaphore.ts";

function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function claudeSseStream(): ReadableStream<Uint8Array> {
  const events = [
    { type: "message_start" },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  return textStream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

afterEach(() => {
  __setTlsFetchOverrideForTesting(null);
  delete process.env.WEB_COOKIE_USE_BROWSER;
  delete process.env.OMNIROUTE_BROWSER_POOL;
  resetSemaphore();
});

describe("Claude Web request serialization per account", () => {
  it("serializes concurrent requests for the same account and executes them strictly one at a time", async () => {
    let activeUpstreamCalls = 0;
    let maxConcurrentUpstreamCalls = 0;
    const executionOrder: string[] = [];

    __setTlsFetchOverrideForTesting(async (url) => {
      if (url.endsWith("/organizations")) {
        return {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: JSON.stringify([{ uuid: "org-1" }]),
          body: null,
        };
      }

      activeUpstreamCalls += 1;
      maxConcurrentUpstreamCalls = Math.max(maxConcurrentUpstreamCalls, activeUpstreamCalls);

      // Artificially simulate upstream processing latency
      await new Promise((resolve) => setTimeout(resolve, 50));

      activeUpstreamCalls -= 1;
      return {
        status: 200,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        text: null,
        body: claudeSseStream(),
      };
    });

    const executor = new ClaudeWebExecutor();
    const creds = {
      cookie: "sessionKey=shared-session-key",
      orgId: "org-1",
    };

    // Dispatch 3 concurrent requests simultaneously for the exact same account
    const req1 = executor
      .execute({
        model: "claude-sonnet-5",
        body: { messages: [{ role: "user", content: "Req 1" }] },
        stream: false,
        credentials: creds,
        signal: null,
      })
      .then((res) => {
        executionOrder.push("req1");
        return res;
      });

    const req2 = executor
      .execute({
        model: "claude-sonnet-5",
        body: { messages: [{ role: "user", content: "Req 2" }] },
        stream: false,
        credentials: creds,
        signal: null,
      })
      .then((res) => {
        executionOrder.push("req2");
        return res;
      });

    const req3 = executor
      .execute({
        model: "claude-sonnet-5",
        body: { messages: [{ role: "user", content: "Req 3" }] },
        stream: false,
        credentials: creds,
        signal: null,
      })
      .then((res) => {
        executionOrder.push("req3");
        return res;
      });

    const results = await Promise.all([req1, req2, req3]);

    for (const res of results) {
      assert.equal(res.response.status, 200);
    }

    // Maximum concurrent upstream calls must strictly be 1 for the same account
    assert.equal(maxConcurrentUpstreamCalls, 1);
    assert.deepEqual(executionOrder, ["req1", "req2", "req3"]);
  });

  it("holds the serialization lock throughout the entire streaming lifecycle until the stream is fully read", async () => {
    let activeStreamingTransports = 0;
    let maxActiveStreamingTransports = 0;
    let releaseFirstStreamChunk: (() => void) | null = null;

    __setTlsFetchOverrideForTesting(async (url) => {
      if (url.endsWith("/organizations")) {
        return {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: JSON.stringify([{ uuid: "org-stream" }]),
          body: null,
        };
      }

      activeStreamingTransports += 1;
      maxActiveStreamingTransports = Math.max(
        maxActiveStreamingTransports,
        activeStreamingTransports
      );

      const encoder = new TextEncoder();
      const customStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"message_start"}\n\n'));
          // Wait for manual trigger before ending stream
          await new Promise<void>((resolve) => {
            releaseFirstStreamChunk = resolve;
          });
          controller.enqueue(
            encoder.encode('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n')
          );
          controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
          controller.close();
          activeStreamingTransports -= 1;
        },
      });

      return {
        status: 200,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        text: null,
        body: customStream,
      };
    });

    const executor = new ClaudeWebExecutor();
    const creds = {
      cookie: "sessionKey=stream-session-key",
      orgId: "org-stream",
    };

    // First request is a streaming request
    const streamPromise = executor.execute({
      model: "claude-sonnet-5",
      body: { messages: [{ role: "user", content: "Stream Request" }] },
      stream: true,
      credentials: creds,
      signal: null,
    });

    const streamResult = await streamPromise;
    assert.equal(streamResult.response.status, 200);

    // Second request dispatched while stream is still open and unread
    let secondReqStarted = false;
    const secondReqPromise = executor
      .execute({
        model: "claude-sonnet-5",
        body: { messages: [{ role: "user", content: "Second Request" }] },
        stream: false,
        credentials: creds,
        signal: null,
      })
      .then((res) => {
        secondReqStarted = true;
        return res;
      });

    // Give microtasks time to attempt to dispatch request 2
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      secondReqStarted,
      false,
      "Second request must remain queued while stream 1 is active"
    );

    // Read the first stream to completion
    const reader = streamResult.response.body?.getReader();
    assert.ok(reader);

    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);

    // Release the rest of the stream
    assert.ok(releaseFirstStreamChunk);
    (releaseFirstStreamChunk as () => void)();

    // Consume remaining chunks until stream finishes
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Now second request should proceed and complete
    const secondResult = await secondReqPromise;
    assert.equal(secondResult.response.status, 200);
    assert.equal(secondReqStarted, true);
    assert.equal(maxActiveStreamingTransports, 1);
  });

  it("allows requests for different accounts to execute concurrently", async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;

    __setTlsFetchOverrideForTesting(async (url) => {
      if (url.endsWith("/organizations")) {
        return {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: JSON.stringify([{ uuid: "org-multi" }]),
          body: null,
        };
      }

      activeCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 50));
      activeCalls -= 1;

      return {
        status: 200,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        text: null,
        body: claudeSseStream(),
      };
    });

    const executor = new ClaudeWebExecutor();

    // Two completely distinct accounts (different session cookies)
    const reqA = executor.execute({
      model: "claude-sonnet-5",
      body: { messages: [{ role: "user", content: "User A" }] },
      stream: false,
      credentials: { cookie: "sessionKey=account-A", orgId: "org-multi" },
      signal: null,
    });

    const reqB = executor.execute({
      model: "claude-sonnet-5",
      body: { messages: [{ role: "user", content: "User B" }] },
      stream: false,
      credentials: { cookie: "sessionKey=account-B", orgId: "org-multi" },
      signal: null,
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    assert.equal(resA.response.status, 200);
    assert.equal(resB.response.status, 200);

    // Both requests ran concurrently since they have distinct account scopes
    assert.equal(maxConcurrent, 2);
  });
});
