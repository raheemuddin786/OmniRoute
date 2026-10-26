import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { getProviderConnections } from "@/lib/db/providers";
import { _providerAllowsOptionalApiKey } from "@/shared/constants/providers";
import {
  EMBEDDING_PROVIDERS,
  getEmbeddingProvider,
} from "@omniroute/open-sse/config/embeddingRegistry.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { getSyncedAvailableModels, getCustomModels } from "@/lib/db/models";

type AvailableEmbeddingModelOption = {
  id: string;
  rawId: string;
  name: string;
  dimensions?: number;
  maxTokens?: number;
  supportedInputTypes: string[];
};

type EmbeddingProviderOption = {
  id: string;
  name: string;
  hasConnection: boolean;
  baseUrl?: string;
  models: AvailableEmbeddingModelOption[];
};

function getProviderBaseUrl(providerSpecificData: unknown): string | undefined {
  if (providerSpecificData && typeof providerSpecificData === "object") {
    const data = providerSpecificData as Record<string, unknown>;
    if (typeof data.baseUrl === "string" && data.baseUrl.trim().length > 0) {
      return data.baseUrl.trim();
    }
  }
  return undefined;
}

// Collect all embedding-relevant models for a given provider from DB
async function getProviderModelsFromDb(
  providerId: string,
  _conns: ReadonlyArray<Record<string, unknown>>
): Promise<AvailableEmbeddingModelOption[]> {
  const modelsMap = new Map<string, AvailableEmbeddingModelOption>();

  // 1. Add synced models from DB
  try {
    const synced = await getSyncedAvailableModels(providerId);
    for (const sm of synced) {
      const isEmbedding =
        sm.modelType === "embedding" ||
        sm.apiFormat === "embeddings" ||
        sm.supportedEndpoints?.includes("embeddings");

      if (isEmbedding) {
        const existing = modelsMap.get(sm.id);
        modelsMap.set(sm.id, {
          id: `${providerId}/${sm.id}`,
          rawId: sm.id,
          name: sm.name || existing?.name || sm.id,
          dimensions: sm.dimensions || existing?.dimensions,
          maxTokens: sm.inputTokenLimit || existing?.maxTokens,
          supportedInputTypes: sm.supportedInputTypes || existing?.supportedInputTypes || ["text"],
        });
      }
    }
  } catch {
    // Fall through on DB error
  }

  // 2. Add custom models from DB
  try {
    const custom = await getCustomModels(providerId);
    if (Array.isArray(custom)) {
      for (const cm of custom) {
        const isEmbedding =
          cm.modelType === "embedding" ||
          cm.apiFormat === "embeddings" ||
          (Array.isArray(cm.supportedEndpoints) && cm.supportedEndpoints.includes("embeddings"));

        if (isEmbedding) {
          const existing = modelsMap.get(cm.id);
          modelsMap.set(cm.id, {
            id: `${providerId}/${cm.id}`,
            rawId: cm.id,
            name: cm.name || existing?.name || cm.id,
            dimensions: cm.dimensions || existing?.dimensions,
            maxTokens: cm.inputTokenLimit || existing?.maxTokens,
            supportedInputTypes: cm.supportedInputTypes ||
              existing?.supportedInputTypes || ["text"],
          });
        }
      }
    }
  } catch {
    // Fall through on DB error
  }

  return Array.from(modelsMap.values());
}

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const activeConnections = (await getProviderConnections({ isActive: true })) as Array<
      Record<string, unknown>
    >;
    const connectionsByProvider = new Map<string, typeof activeConnections>();

    for (const conn of activeConnections) {
      const p = conn.provider;
      if (!p) continue;
      const list = connectionsByProvider.get(p) || [];
      list.push(conn);
      connectionsByProvider.set(p, list);
    }

    // Collect all candidate providers: configured connections + curated EMBEDDING_PROVIDERS
    const candidateProviders = new Set<string>([
      ...Object.keys(EMBEDDING_PROVIDERS),
      ...connectionsByProvider.keys(),
    ]);

    const providerOptions: EmbeddingProviderOption[] = [];

    for (const providerId of candidateProviders) {
      const conns = connectionsByProvider.get(providerId) || [];
      const activeConn = conns.find((c) => c.isActive !== false) || conns[0];
      const hasConnection = conns.length > 0;

      const curated = getEmbeddingProvider(providerId);
      const configuredBaseUrl = activeConn
        ? getProviderBaseUrl(activeConn.providerSpecificData)
        : undefined;
      const baseUrl = configuredBaseUrl || curated?.baseUrl;

      // Collect models for this provider
      const models = await getProviderModelsFromDb(providerId, conns);

      if (models.length > 0 || curated !== undefined || hasConnection) {
        providerOptions.push({
          id: providerId,
          name: activeConn?.name || (curated ? providerId : providerId),
          hasConnection,
          baseUrl,
          models,
        });
      }
    }

    providerOptions.sort((a, b) => {
      if (a.hasConnection !== b.hasConnection) {
        return a.hasConnection ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Flatten to model options for the Qdrant dropdown
    const modelOptions: {
      value: string;
      label: string;
      dimensions?: number;
    }[] = [];

    for (const po of providerOptions) {
      for (const m of po.models) {
        modelOptions.push({
          value: m.id,
          label: `${m.id} - ${m.name}${m.dimensions ? ` (${m.dimensions}d)` : ""}`,
          dimensions: m.dimensions,
        });
      }
    }

    // Sort: alphabetically by label
    modelOptions.sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({ models: modelOptions });
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: { message }, models: [] }, { status: 500 });
  }
}
