---
title: "Smart Proxy Bridge (SPB) UI Configuration & Model Discovery Guide"
version: 1.0.0
lastUpdated: 2026-10-13
---

# Smart Proxy Bridge (SPB) UI Configuration & Model Discovery Guide

This guide provides step-by-step operational instructions for configuring and monitoring the **Smart Proxy Bridge with Intelligent Routing (SPB-IR)** directly within the **OMMIROT** (OmniRoute) dashboard, alongside the underlying architecture for automatic model discovery and capability management.

---

## 1. Exact Step-by-Step Procedure to Configure SPB in the OMIROT UI

The OMIROT Dashboard provides a dedicated management and telemetry tab for SPB-IR, allowing operators and developers to monitor routing health, active model tiers, prompt cache hit ratios, and SQLite state checkpoints in real time.

### Step 1: Access the OMIROT Dashboard

1. Open your browser and navigate to the local OMIROT operator instance:
   ```text
   http://localhost:20128/dashboard
   ```
2. Authenticate using your admin credentials (configured via `INITIAL_PASSWORD` on first boot).

### Step 2: Navigate to Endpoint & Smart Proxy Management

1. From the sidebar or dashboard navigation, click on **Endpoints** or directly visit:
   ```text
   http://localhost:20128/dashboard/endpoint
   ```
2. Locate the segmented control navigation at the top of the endpoint page containing tabs for **APIs**, **MCP**, **A2A**, **Context Sources**, and **Smart Proxy**.

### Step 3: Open the Smart Proxy Bridge Tab

1. Click on the **Smart Proxy** tab.
2. The interface will render the `<SmartProxyBridgeTab />` component, presenting:
   - **Total Requests Routed:** Real-time metrics tracking multi-agent query volume.
   - **Prompt Cache Hit Rate:** Percentage of prompts leveraging upstream server-side caching (preventing cache eviction across hops).
   - **Active Checkpoints:** Number of WAL-journaled SQLite session state checkpoints.
   - **Zero-Loss Failover:** Success rate of automated recovery during rate limits (`429`) or upstream outages (`503`).

### Step 4: Configure Client Routing Requests

To route agentic workflows through SPB-IR programmatically, include the routing strategy header in your API requests:

```bash
curl -X POST http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer or-key-..." \
  -H "Content-Type: application/json" \
  -H "X-OmniRoute-Strategy: smart-proxy-bridge" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Refactor this TypeScript service and write automated unit tests."}
    ]
  }'
```

---

## 2. Tire Model Integration & Management: Automatic Discovery vs. Manual Customization

A common question among engineers is whether model catalog entries (tire models and provider capabilities) require manual hard-coding or if they are managed automatically.

### Automatic Discovery & Population

- **Upstream Sync:** OmniRoute automatically discovers, catalogs, and syncs available models from upstream providers via built-in provider registry crawlers and sync workers (`open-sse/config/providerRegistry.ts`, `antigravitySharedModels.ts`, and `src/lib/db/models/`).
- **Zero Manual Overhead:** When new models or provider capabilities are released upstream, OMIROT's discovery pipeline indexes them automatically without requiring manual configuration files or hard-coded edits.

### Optional Operator Customization & Overrides

- While discovery is fully automated, operators retain granular control through **capability overrides** and **context overrides** (`src/lib/db/modelCapabilityOverrides.ts`).
- If custom token limits, reasoning effort constraints, or specific tier mappings are required, operators can configure them via the **Models Catalog** (`/dashboard/models`) or database configuration tables without altering core runtime code.

---

## 3. Root Cause Analysis & Underlying Architecture

### Root Cause of Previous Omissions

Initial development iterations focused intensely on core backend routing algorithms (intent classification, tiered model mapping, and SQLite WAL checkpointing), resulting in a gap where the UI tab wiring (`SmartProxyBridgeTab.tsx`) and documentation for automatic model discovery had not yet been formally exposed in the main operator documentation.

### Underlying Architecture

1. **Intent Analysis & Phase Classification:** Inspects incoming prompts for architectural planning, code generation, testing, refactoring, or deterministic routing.
2. **Tiered Model Hierarchy:**
   - **Tier 1 (Apex Reasoning):** `claude-3-5-sonnet`, `gpt-4o`, `claude-opus-5-5`
   - **Tier 2 (Resilient Execution):** `claude-3-5-sonnet`, `deepseek-coder`, `gemini-1-5-pro`
   - **Tier 3 (Local Edge Inference):** `llama-3-8b-instruct`, local Ollama/vLLM
3. **State Checkpointing & Prompt Anchors:** Computes SHA-256 prefix hashes (`prompt_anchor_hash`) and persists checkpoints atomically in SQLite (`src/lib/db/spbState.ts`) to achieve instant zero-loss state resumption upon failover.

---

## 4. Verification & Audit

All backend components, dashboard UI integration points, and test suites (`tests/unit/spb-intent.test.ts`, `tests/integration/spb-resilience.test.ts`) are verified and passing with exit status `0`.
