import type { ModelInfo, ProviderPreset } from "@ghost/contract";
import type { Provider as PiProvider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

/** The contract caps one bundled catalog at 256 entries. */
const CATALOG_LIMIT = 256;

/**
 * Static chat metadata of one bundled SDK provider. Building the provider and
 * calling `getModels()` is pure — no credential is read and no request is made —
 * so this is safe at module scope. Duplicate ids keep the first entry's
 * metadata, and the catalog is capped at the contract limit.
 */
function chatCatalog(provider: PiProvider): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const model of provider.getModels()) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, name: model.name, contextWindow: model.contextWindow, reasoning: model.reasoning });
    if (models.length === CATALOG_LIMIT) break;
  }
  return models;
}

/** The suggested default id only when the bundled catalog actually contains it; null, never a guessed fallback. */
const recommended = (models: ModelInfo[], suggested: string): string | null =>
  models.some((model) => model.id === suggested) ? suggested : null;

const openai = openaiProvider();
const codex = openaiCodexProvider();
const anthropic = anthropicProvider();
const google = googleProvider();
const zai = zaiProvider();
const minimax = minimaxProvider();

const openaiModels = chatCatalog(openai);
const codexModels = chatCatalog(codex);
const anthropicModels = chatCatalog(anthropic);
const googleModels = chatCatalog(google);
const zaiModels = chatCatalog(zai);
const minimaxModels = chatCatalog(minimax);

/**
 * Bundled provider presets, computed once at module scope from the installed
 * pi-ai SDK: default base urls come from the SDK factories and catalogs from
 * their static model metadata. `oauthModels` carries the ChatGPT-login (Codex)
 * catalog for OpenAI only. Credentials are never read and no requests are made.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    kind: "openai",
    name: "OpenAI",
    baseUrl: openai.baseUrl ?? null,
    credentialUrl: "https://platform.openai.com/api-keys",
    models: openaiModels,
    oauthModels: codexModels,
    recommendedModelId: recommended(openaiModels, "gpt-6-luna"),
    recommendedOAuthModelId: recommended(codexModels, "gpt-6-luna"),
  },
  {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    baseUrl: anthropic.baseUrl ?? null,
    credentialUrl: "https://platform.claude.com/settings/keys",
    models: anthropicModels,
    oauthModels: [],
    recommendedModelId: recommended(anthropicModels, "claude-sonnet-5-5"),
    recommendedOAuthModelId: null,
  },
  {
    id: "google",
    kind: "google",
    name: "Google Gemini",
    baseUrl: google.baseUrl ?? null,
    credentialUrl: "https://aistudio.google.com/apikey",
    models: googleModels,
    oauthModels: [],
    recommendedModelId: recommended(googleModels, "gemini-3.8-flash"),
    recommendedOAuthModelId: null,
  },
  {
    id: "zai",
    kind: "zai",
    name: "Z.AI Coding Plan",
    baseUrl: zai.baseUrl ?? null,
    credentialUrl: "https://z.ai/manage-apikey/apikey-list",
    models: zaiModels,
    oauthModels: [],
    recommendedModelId: recommended(zaiModels, "glm-5.3"),
    recommendedOAuthModelId: null,
  },
  {
    id: "minimax",
    kind: "minimax",
    name: "MiniMax",
    baseUrl: minimax.baseUrl ?? null,
    credentialUrl: "https://platform.minimax.io/console/keys",
    models: minimaxModels,
    oauthModels: [],
    recommendedModelId: recommended(minimaxModels, "MiniMax-M3"),
    recommendedOAuthModelId: null,
  },
  {
    id: "custom",
    kind: "openai_compatible",
    name: "OpenAI 호환 서버",
    baseUrl: null,
    credentialUrl: null,
    models: [],
    oauthModels: [],
    recommendedModelId: null,
    recommendedOAuthModelId: null,
  },
];
