# ADR-0024: Canonical Model Resolution & Anti-Workaround Governance Standard

## Status

Accepted

## Context

When integrating third-party clients and protocols (such as Claude Desktop, Claude Code, Cursor, and web-based LLM platforms), incoming requests often specify historical, vendor-deprecated, or client-specific model identifiers (e.g., `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620`).

In prior implementations, ad-hoc hot-fixes were introduced at leaf executor levels (such as substring matching heuristics like `if (model.includes("sonnet"))`) or point-patches on single routes. This pattern violates the Single Source of Truth (SSOT), introduces silent routing drifts, causes maintainability fragility, and masks upstream provider tier constraints.

## Decision

1. **Centralized Provider Registry as SSOT**:
   All model definitions and their accepted provider-specific aliases must be explicitly registered within `open-sse/config/providers/registry/<provider>/index.ts` under each model's `aliases` field.
2. **Deterministic Lookup in Adapters**:
   Leaf executors and payload transformers must never implement ad-hoc regex or substring heuristics. They must perform deterministic $O(1)$ lookups backed directly by the provider registry definition.
3. **Unified Route-Level Alias Normalization**:
   All ingress routes (`/v1/chat/completions`, `/v1/messages`, etc.) must apply canonical alias normalization via `resolveModelAliasWithSeedFallbackOnBody` prior to delegating to `handleChat` and downstream executors.
4. **Deprecation Auto-Forwarding**:
   Global vendor deprecations must be maintained in `open-sse/services/modelDeprecation.ts` (`BUILT_IN_ALIASES`) and kept in sync with `config/quality/model-lifecycle.json` through the `npm run check:model-lifecycle` anti-drift gate.

## Consequences

- **Positive**: Eliminates model routing hallucinations and false-matching on future checkpoints.
- **Positive**: Maintains strict architectural layering and SSOT principles across executors and routes.
- **Positive**: Fully testable through hermetic unit tests and automated anti-drift ratchets.
