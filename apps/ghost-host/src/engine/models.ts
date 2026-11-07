import type { ModelInfo, Provider as ContractProvider, Settings } from "@ghost/contract";
import type { Api, Credential, Model, MutableModels, OAuthAuth, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Secrets } from "../core/ports.ts";
import { modelInputFor } from "../integrations/provider-catalog.ts";

/** Which pi-ai API speaks each provider kind. */
const API_BY_KIND = {
  openai: "openai-responses",
  openai_compatible: "openai-completions",
  anthropic: "anthropic-messages",
  zai: "openai-completions",
  minimax: "anthropic-messages",
  google: "google-generative-ai",
} as const satisfies Record<ContractProvider["kind"], Api>;

/** Where a provider lives when the owner did not give a base URL. */
const BASE_URL_BY_KIND = {
  openai: "https://api.openai.com/v1",
  openai_compatible: null,
  anthropic: "https://api.anthropic.com",
  zai: "https://api.z.ai/api/coding/paas/v4",
  minimax: "https://api.minimax.io/anthropic",
  google: "https://generativelanguage.googleapis.com/v1beta",
} as const satisfies Record<ContractProvider["kind"], string | null>;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

/** The only endpoint an OAuth (ChatGPT) OpenAI credential may talk to. */
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Codex OAuth login/refresh implementation, memoized so every OAuth-backed OpenAI provider shares one. */
let codexAuth: OAuthAuth | undefined;

function streamsFor(api: Api): ProviderStreams {
  switch (api) {
    case "openai-responses":
      return openAIResponsesApi();
    case "openai-completions":
      return openAICompletionsApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    default:
      throw new Error(`no pi-ai API implementation for ${api}`);
  }
}

function modelOf(provider: ContractProvider, info: ModelInfo, api: Api, baseUrl: string): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api,
    provider: provider.id,
    baseUrl,
    input: modelInputFor(provider.kind, info.id, api),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: info.reasoning ?? false,
  };
}

/**
 * One pi-ai provider for one configured provider row. The credential lives in
 * the host's secret store; `Models` reads it through the store at request
 * time, so a rotated API key is picked up without rebuilding the provider.
 * An OpenAI row carrying an OAuth credential speaks the Codex API against the
 * trusted ChatGPT backend, whatever base URL the row configures.
 */
export function createHostProvider(provider: ContractProvider, credential: Credential | undefined): Provider | null {
  const codex = provider.kind === "openai" && credential?.type === "oauth";
  const api: Api = codex ? "openai-codex-responses" : API_BY_KIND[provider.kind];
  const baseUrl = codex ? CODEX_BASE_URL : (provider.baseUrl ?? BASE_URL_BY_KIND[provider.kind]);
  if (!baseUrl) return null;
  return createProvider<Api>({
    id: provider.id,
    name: provider.name,
    baseUrl,
    auth: codex
      ? { oauth: (codexAuth ??= openaiCodexProvider().auth.oauth!) }
      : {
          apiKey: {
            name: `${provider.name} API key`,
            // Only the Ghost secret resolves here; ambient environment is never consulted.
            resolve: async ({ credential }) =>
              credential?.type === "api_key" && credential.key
                ? { auth: { apiKey: credential.key }, source: "Ghost secrets" }
                : undefined,
          },
        },
    models: provider.models.map((info) => modelOf(provider, info, api, baseUrl)),
    api: codex ? openAICodexResponsesApi() : streamsFor(api),
  });
}

/** The model catalog of every configured provider. */
export function buildModels(settings: Settings, secrets: Secrets): MutableModels {
  const models = createModels({ credentials: secrets });
  applyProviders(models, settings, secrets);
  return models;
}

/** Replace the catalog with the configured providers; a provider that is gone goes with it. */
export function applyProviders(models: MutableModels, settings: Settings, secrets: Secrets): void {
  models.clearProviders();
  for (const provider of settings.providers) {
    const created = createHostProvider(provider, secrets.credential(provider.id));
    if (created) models.setProvider(created);
  }
}
