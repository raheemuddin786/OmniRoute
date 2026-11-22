import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getConnectionInFlight,
  acquireConnectionFlight,
  sortByLeastInFlight,
  getLeastInFlightConnection,
  resetConnectionConcurrencyTracker,
} from "../../src/sse/services/connectionConcurrencyTracker";
import {
  extractSessionAffinityKey,
  selectSessionAffinityConnection,
  planSessionAffinityConnection,
} from "../../src/sse/services/sessionAffinityPin";
import { shouldTripProviderBreakerForResult } from "../../src/sse/handlers/chatPredicates";
import { extractExternalSessionId } from "../../open-sse/services/sessionManager";

describe("Connection Concurrency Balancing for Multi-Agent Workflows", () => {
  beforeEach(() => {
    resetConnectionConcurrencyTracker();
  });

  describe("In-flight Concurrency Tracker", () => {
    it("tracks acquire and release of connection slots accurately", () => {
      assert.equal(getConnectionInFlight("conn-1"), 0);

      const release1 = acquireConnectionFlight("conn-1");
      assert.equal(getConnectionInFlight("conn-1"), 1);

      const release2 = acquireConnectionFlight("conn-1");
      assert.equal(getConnectionInFlight("conn-1"), 2);

      // Release first slot
      release1();
      assert.equal(getConnectionInFlight("conn-1"), 1);

      // Release second slot
      release2();
      assert.equal(getConnectionInFlight("conn-1"), 0);

      // Idempotent release does not go below 0
      release2();
      assert.equal(getConnectionInFlight("conn-1"), 0);
    });

    it("sorts connections preferring idle connections first, then priority", () => {
      const connections = [
        { id: "conn-1", priority: 1 },
        { id: "conn-2", priority: 1 },
        { id: "conn-3", priority: 2 },
      ];

      // Mark conn-1 busy with 1 active in-flight request
      acquireConnectionFlight("conn-1");

      const sorted = sortByLeastInFlight(connections);
      // conn-2 has inFlight 0, priority 1 -> should come first
      assert.equal(sorted[0].id, "conn-2");
      // conn-3 has inFlight 0, priority 2 -> should come second
      assert.equal(sorted[1].id, "conn-3");
      // conn-1 has inFlight 1, priority 1 -> should come last because it is busy
      assert.equal(sorted[2].id, "conn-1");
    });

    it("getLeastInFlightConnection picks the first idle connection", () => {
      const connections = [{ id: "conn-a" }, { id: "conn-b" }, { id: "conn-c" }];

      acquireConnectionFlight("conn-a");
      const best = getLeastInFlightConnection(connections);
      assert.equal(best?.id, "conn-b");
    });
  });

  describe("Session Affinity Parallel Request Balancing", () => {
    it("balances concurrent turn to an idle sibling when pinned connection is busy", async () => {
      const connections = [
        { id: "conn-primary", priority: 1, consecutiveUseCount: 0, lastUsedAt: null },
        { id: "conn-sibling", priority: 2, consecutiveUseCount: 0, lastUsedAt: null },
      ];

      const sessionKey = "session-test-parallel";
      const provider = "nvidia";

      // 1. First sequential request: selects conn-primary and pins it
      const firstSelection = await selectSessionAffinityConnection(
        provider,
        sessionKey,
        connections,
        60_000
      );
      assert.equal(firstSelection?.id, "conn-primary");

      // 2. Simulate conn-primary is currently executing (in-flight = 1)
      const releasePrimary = acquireConnectionFlight("conn-primary");
      assert.equal(getConnectionInFlight("conn-primary"), 1);

      // 3. Parallel request from Agent 2 in the same session:
      // Pinned conn-primary is busy, so it must balance to idle sibling
      const secondSelection = await selectSessionAffinityConnection(
        provider,
        sessionKey,
        connections,
        60_000
      );
      assert.equal(secondSelection?.id, "conn-sibling");

      // Release primary flight
      releasePrimary();
      assert.equal(getConnectionInFlight("conn-primary"), 0);

      // 4. Once primary is idle again, serial turn returns to pinned connection
      const thirdSelection = await selectSessionAffinityConnection(
        provider,
        sessionKey,
        connections,
        60_000
      );
      assert.equal(thirdSelection?.id, "conn-primary");
    });

    it("planSessionAffinityConnection balances when existingConnection is in-flight", () => {
      const connections = [
        { id: "conn-pinned", consecutiveUseCount: 2, lastUsedAt: new Date().toISOString() },
        { id: "conn-idle-sibling", consecutiveUseCount: 0, lastUsedAt: null },
      ];

      const sessionKey = "session-plan-test";
      const provider = "cohere";

      // Mark pinned connection busy
      acquireConnectionFlight("conn-pinned");

      const plan = planSessionAffinityConnection(provider, sessionKey, connections, 60_000);
      assert.ok(plan);
      // Because conn-pinned is in-flight, plan routes to idle sibling
      assert.equal(plan.connection.id, "conn-idle-sibling");
    });
  });

  describe("Agent-Specific Session Key Isolation", () => {
    it("extracts session key from agent headers preventing cross-agent collision", () => {
      const body = {
        messages: [{ role: "user", content: "Implement a distributed router" }],
      };

      const headersAgent1 = new Headers({ "x-agent-id": "agent-orchestrator" });
      const headersAgent2 = new Headers({ "x-agent-id": "agent-worker-1" });

      const key1 = extractSessionAffinityKey(body, headersAgent1);
      const key2 = extractSessionAffinityKey(body, headersAgent2);

      assert.ok(key1);
      assert.ok(key2);
      assert.notEqual(key1, key2);
      assert.equal(key1, "header:agent-orchestrator");
      assert.equal(key2, "header:agent-worker-1");
    });

    it("extracts session key from Cline task id and Cursor session headers", () => {
      const body = { messages: [{ role: "user", content: "Fix bug" }] };

      const clineHeaders = new Headers({ "x-cline-task-id": "task-abc-123" });
      assert.equal(extractSessionAffinityKey(body, clineHeaders), "header:task-abc-123");

      const cursorHeaders = new Headers({ "x-cursor-session-id": "cursor-sess-456" });
      assert.equal(extractSessionAffinityKey(body, cursorHeaders), "header:cursor-sess-456");
    });

    it("extracts session key from OpenAI body user field", () => {
      const body1 = {
        messages: [{ role: "user", content: "Identical prompt across agents" }],
        user: "agent-alpha",
      };
      const body2 = {
        messages: [{ role: "user", content: "Identical prompt across agents" }],
        user: "agent-beta",
      };

      const key1 = extractSessionAffinityKey(body1, null);
      const key2 = extractSessionAffinityKey(body2, null);

      assert.equal(key1, "user:agent-alpha");
      assert.equal(key2, "user:agent-beta");
      assert.notEqual(key1, key2);
    });

    it("extractExternalSessionId parses agent task and session headers", () => {
      const headers = new Headers({ "x-agent-session-id": "subagent-run-789" });
      const extSessionId = extractExternalSessionId(headers);
      assert.equal(extSessionId, "ext:subagent-run-789");
    });
  });

  describe("Provider Circuit Breaker Protection from Local Saturation", () => {
    it("does not trip provider breaker on local saturation or pool busy error codes", () => {
      const localBusyCodes = [
        "antigravity_pool_busy",
        "chat_admission_busy",
        "all_connections_busy",
        "admission_limit_exceeded",
        "concurrency_limit_exceeded",
      ];

      for (const errorCode of localBusyCodes) {
        const result = {
          status: 503,
          errorCode,
          error: "Local queue saturated",
        };
        const shouldTrip = shouldTripProviderBreakerForResult(result, false, false);
        assert.equal(
          shouldTrip,
          false,
          `Local saturation error code ${errorCode} must NOT trip the provider breaker`
        );
      }
    });

    it("still trips provider breaker on genuine upstream 503 errors", () => {
      const result = {
        status: 503,
        errorCode: "service_unavailable",
        error: "Upstream Cloudflare 503 Service Unavailable",
      };
      const shouldTrip = shouldTripProviderBreakerForResult(result, false, false);
      assert.equal(shouldTrip, true, "Genuine upstream 503 should trip provider breaker");
    });
  });
});
