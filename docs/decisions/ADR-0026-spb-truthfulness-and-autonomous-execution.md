# ADR-0026: Smart Proxy Bridge (SPB) Truthfulness, Tool Contiguity, and Autonomous Execution Invariants

## Status

Accepted

## Context

Following rapid iterations in the Smart Proxy Bridge (SPB) subsystem, regressions were introduced across commits `45b440d6f3..HEAD` that manifested in four major failure modes:

1. **Tool-Call Contiguity Severance**: Naive message history slicing on turns > 120 severed contiguous `tool_use` and `tool_result` blocks, causing upstream provider 400 Bad Request errors.
2. **Mode-Pack Reliability Inversion**: The `:reliable` mode pack had `tierAffinity: 0`, inadvertently routing high-complexity agentic coding tasks to low-capability models (`tier_3_local`).
3. **RLHF Grounding Helplessness**: Grounding instructions asserted that the local workspace was the sole authority, causing models presented with external URLs to claim an inability to browse the live web and trigger false-positive stagnation recovery loops.
4. **Custom Model Tier Cost Demotion**: Cost-aware candidate sorting in tiered registry lookups reordered user-configured custom models by price rather than honoring operator-defined precedence.

## Decision

To guarantee zero partial changes, truthful execution, and strict adherence to architectural invariants, the following technical solutions are established:

1. **Tool-Pair Boundary Scanning (`open-sse/handlers/chatCore.ts`)**:
   Implement a bidirectional window-scanning compaction algorithm that locates safe boundary indices, ensuring that `tool_use` and `tool_result` pairs are never partitioned across truncation cuts.

2. **Mode-Pack Weight Invariants (`open-sse/services/autoCombo/modePacks.ts`)**:
   Enforce non-zero `tierAffinity` (0.12) and `specificityMatch` (0.06) in `:reliable` mode packs, guaranteeing that high-capability tiers are selected for complex multi-file engineering tasks while maintaining a strict matrix sum of `0.9999`.

3. **External Reference Protocol & Dual Grounding (`open-sse/services/spb/inboundIntelligence.ts` & `tieredRegistry.ts`)**:
   Detect external HTTP/HTTPS URLs in user prompts and inject dual-grounding guidance: external URLs serve as the authority for remote references, while the local workspace serves as authority for local file mutations. Supply clear CLI tool guidance (`curl -sL`) to prevent models from claiming browsing incapacity or entering stagnation loops.

4. **Operator Priority Preservation (`open-sse/services/spb/tieredRegistry.ts`)**:
   Parameterize candidate ranking with `preserveOrder = isCustom || isUserMode`. When user-selected or custom tier models are evaluated, their healthy candidates preserve operator preference order without demotion by cost-sorting heuristics.

5. **Observable Evidence Requirement for Terminal Ledger States (`open-sse/services/spb/apexLedger.ts` & `contextHandoff.ts`)**:
   Require non-empty observable file diff or test execution evidence before accepting a task item as `done`. Inject explicit handoff rules directing receiving agents to verify disk state before modifying files.

## Consequences

- Prevents upstream 400 errors on long agentic conversations (>120 turns).
- Ensures complex code generation and architectural tasks route to Tier 1/2 models.
- Eliminates false assertions regarding lack of live web access.
- Retains operator agency and custom model selection priority.
