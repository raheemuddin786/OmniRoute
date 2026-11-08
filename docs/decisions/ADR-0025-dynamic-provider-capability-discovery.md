# ADR-0025: Dynamic Provider Capability Discovery & Service-Kind Resolution

## Status

Accepted

## Context

OmniRoute handles two distinct categories of providers:

1. **Curated Upstream Providers**: Statically defined in core engine registries (e.g., OpenAI, Anthropic, Gemini, Mistral).
2. **Custom / Compatible Provider Nodes**: Dynamic runtime nodes configured by operators in the database (e.g., local AI engines, self-hosted gateways, OpenAI-compatible or Anthropic-compatible endpoints) across multiple modalities such as chat, embeddings, image generation, speech-to-text, and text-to-speech.

Historically, capability filters on the Providers Dashboard (`/dashboard/providers`) and downstream configuration endpoints (such as Qdrant vector memory embedding options and Semantic Cache settings) relied strictly on static registry lookups. As a result:

- Dynamic custom nodes configured in the database lacked declared service capabilities in the UI layer and were excluded whenever an operator applied a capability filter (e.g., the "Embedding" chip).
- Configuration dropdowns either failed to discover custom embedding models or exposed internal database connection UUIDs rather than the routable public prefix (e.g., `<prefix>/<modelId>`) and human-readable node name.

## Decision

1. **Dynamic Service-Kind Resolution in Core Engine**:
   `open-sse/config/mediaServiceKinds.ts` (`resolveProviderServiceKinds`) must dynamically resolve service kinds for compatible provider nodes based on their identifier and API type rather than relying solely on static dictionary membership:
   - `embeddings` -> `embedding`
   - `images-generations` -> `image`
   - `audio-transcriptions` -> `stt`
   - `audio-speech` -> `tts`
   - `chat` / `responses` -> `llm`

2. **Client-Side Compatible Group Assembly**:
   In `src/app/(dashboard)/dashboard/providers/providerPageUtils.ts`, `buildCompatibleProviderGroups` must derive and assign `serviceKinds` for each custom provider group based on its underlying API type. When `filterConfiguredProviderEntries` evaluates entries against an active media or category filter, matching custom nodes are retained in the grid.

3. **UI Badge De-duplication**:
   `ProviderCard.tsx` must suppress generic service-kind badges on compatible provider cards to prevent visual duplication against specialized compatibility indicators.

4. **Dynamic Database-Driven Model Resolution for Integrations**:
   Configuration routes for vector memory (`/api/settings/qdrant/embedding-models`) and Semantic Cache (`embeddingOptions.ts`) must:
   - Dynamically inspect active `provider_connections` and custom/synced model records in the database.
   - Format all selectable model values using their routable public prefix (`${prefix}/${modelId}`) derived from `providerSpecificData.prefix`.
   - Resolve display names using operator-configured `nodeName` rather than internal connection identifiers or generic labels.

## Consequences

- **Positive**: Custom and local provider nodes automatically inherit proper capability tags and appear in dashboard filters according to their configured API mode.
- **Positive**: Integrations (Qdrant, Semantic Cache) can seamlessly consume models from custom provider nodes using routable, user-friendly identifiers.
- **Positive**: Eliminates the need to modify static code registries whenever new custom or local provider nodes are introduced.
