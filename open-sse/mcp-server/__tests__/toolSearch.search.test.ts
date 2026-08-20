import { describe, it, expect } from "vitest";
import { searchTools } from "../toolSearch/search.ts";

const E = [
  {
    name: "omniroute_get_health",
    description: "health status uptime memory",
    scopes: ["read:health"],
  },
  {
    name: "omniroute_list_combos",
    description: "list combos and strategies",
    scopes: ["read:combos"],
  },
  {
    name: "omniroute_check_quota",
    description: "remaining quota per provider",
    scopes: ["read:quota"],
  },
];

describe("searchTools", () => {
  it("ranks name+desc hit on top", () => {
    const r = searchTools(E, "health", 8);
    expect(r[0].name).toBe("omniroute_get_health");
  });
  it("no hit ⇒ empty", () => {
    expect(searchTools(E, "zzzzz", 8)).toEqual([]);
  });
  it("respects limit + deterministic tie-break", () => {
    const r = searchTools(E, "omniroute", 2);
    expect(r.length).toBe(2);
    expect(r[0].name < r[1].name).toBe(true); // tie-break alfabético
  });
  it("handles client prefix mcp_ and returns exact match", () => {
    const r = searchTools(
      [
        ...E,
        {
          name: "omniroute_memory_add",
          description: "add memory to omniroute db",
          scopes: ["read:memory"],
        },
      ],
      "mcp_omniroute_memory_add",
      8
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].name).toBe("omniroute_memory_add");
  });
  it("ReDoS-safe: pathological query does not hang", () => {
    const start = Date.now();
    searchTools(E, "(a+)+".repeat(20), 8);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
