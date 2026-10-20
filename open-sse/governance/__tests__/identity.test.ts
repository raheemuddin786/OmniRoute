import { describe, it, expect } from "vitest";

import { resolveGovernanceIdentity } from "../identity.ts";

/**
 * The governance identity MUST reuse the repo's existing session-key scheme so
 * the audit trail joins with the rest of the system:
 *   - `x-session-id` (and its variants) → `ext:<raw≤64>`
 *   - otherwise the SHA-256 conversation fingerprint (16 hex chars)
 *   - otherwise the caller's per-request fallback
 *   - otherwise the literal "anonymous"
 */

describe("governance identity", () => {
  describe("external session id", () => {
    it("prefers the client-supplied session header", () => {
      const identity = resolveGovernanceIdentity({
        headers: new Headers({ "x-session-id": "abc123" }),
        body: { model: "gpt-4" },
      });
      expect(identity.sessionId).toBe("ext:abc123");
      expect(identity.source).toBe("external");
    });

    it("accepts the underscore variant", () => {
      const identity = resolveGovernanceIdentity({
        headers: new Headers({ x_session_id: "under" }),
      });
      expect(identity.sessionId).toBe("ext:under");
    });

    it("accepts the OmniRoute-specific header", () => {
      const identity = resolveGovernanceIdentity({
        headers: new Headers({ "x-omniroute-session": "omni" }),
      });
      expect(identity.sessionId).toBe("ext:omni");
    });

    it("truncates an over-long session id to 64 chars", () => {
      const raw = "z".repeat(200);
      const identity = resolveGovernanceIdentity({
        headers: new Headers({ "x-session-id": raw }),
      });
      expect(identity.sessionId).toBe(`ext:${"z".repeat(64)}`);
    });

    it("ignores a blank session header", () => {
      const identity = resolveGovernanceIdentity({
        headers: new Headers({ "x-session-id": "   " }),
        body: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
      });
      expect(identity.source).toBe("fingerprint");
    });
  });

  describe("conversation fingerprint", () => {
    it("derives a stable 16-hex-char fingerprint", () => {
      const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
      const first = resolveGovernanceIdentity({ body });
      const second = resolveGovernanceIdentity({ body });
      expect(first.source).toBe("fingerprint");
      expect(first.sessionId).toMatch(/^[0-9a-f]{16}$/);
      expect(first.sessionId).toBe(second.sessionId);
    });

    it("separates different conversations", () => {
      const a = resolveGovernanceIdentity({
        body: { model: "gpt-4", messages: [{ role: "user", content: "a" }] },
      });
      const b = resolveGovernanceIdentity({
        body: { model: "gpt-4", messages: [{ role: "user", content: "b" }] },
      });
      expect(a.sessionId).not.toBe(b.sessionId);
    });

    it("includes the provider in the fingerprint", () => {
      const body = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
      const withProvider = resolveGovernanceIdentity({ body, provider: "openai" });
      const withoutProvider = resolveGovernanceIdentity({ body });
      expect(withProvider.sessionId).not.toBe(withoutProvider.sessionId);
    });

    it("includes the connection id in the fingerprint", () => {
      const body = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
      const a = resolveGovernanceIdentity({ body, connectionId: "conn-1" });
      const b = resolveGovernanceIdentity({ body, connectionId: "conn-2" });
      expect(a.sessionId).not.toBe(b.sessionId);
    });
  });

  describe("fallbacks", () => {
    it("uses the fallback key when the body yields no fingerprint", () => {
      const identity = resolveGovernanceIdentity({ body: {}, fallback: "req-42" });
      expect(identity.sessionId).toBe("req-42");
      expect(identity.source).toBe("fallback");
    });

    it("uses the literal anonymous key when there is no fallback", () => {
      const identity = resolveGovernanceIdentity({ body: {} });
      expect(identity.sessionId).toBe("anonymous");
      expect(identity.source).toBe("anonymous");
    });
  });

  describe("principal", () => {
    it("resolves the principal from the API key id", () => {
      const identity = resolveGovernanceIdentity(
        { headers: new Headers({ "x-session-id": "s" }) },
        { id: 7 }
      );
      expect(identity.principalId).toBe("7");
    });

    it("stringifies a string API key id", () => {
      const identity = resolveGovernanceIdentity({}, { id: "key-abc" });
      expect(identity.principalId).toBe("key-abc");
    });

    it("omits the principal when the API key id is unknown", () => {
      const identity = resolveGovernanceIdentity({}, null);
      expect(identity.principalId).toBeUndefined();
    });
  });

  describe("fail open", () => {
    it("never throws on a null headers object", () => {
      expect(() => resolveGovernanceIdentity({ headers: null, body: null })).not.toThrow();
    });

    it("never throws on a hostile body", () => {
      const hostile = {
        get model(): never {
          throw new Error("boom");
        },
      };
      expect(() => resolveGovernanceIdentity({ body: hostile, fallback: "fb" })).not.toThrow();
    });
  });
});
