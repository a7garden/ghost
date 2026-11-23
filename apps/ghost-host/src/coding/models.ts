import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import type { CodingSession, CodingThinking, Settings } from "@ghost/contract";
import { CommandError, invalid } from "../core/errors.ts";
import type { Secrets } from "../core/ports.ts";
import { createHostProvider } from "../engine/models.ts";
import type { ProviderCatalog } from "../integrations/provider-catalog.ts";

type ModelRef = CodingSession["model"];
const THINKING: readonly CodingThinking[] = ["off", "low", "medium", "high"];
export interface CodingModelSource {
  settings(): Settings;
  secrets: Secrets;
  catalog: ProviderCatalog;
  /** Tests may replace a configured transport, not the model or credential admission gates. */
  provider?: typeof createHostProvider;
}


export interface CodingModelSelection { model: Model<Api>; runtime: ModelRuntime; thinking: CodingThinking }
/** Pi's runtime owns request/auth preparation, using the same native providers as Ghost Durable. */
export class CodingModels {
  private runtime: Promise<ModelRuntime> | undefined;
  private readonly registered = new Map<string, string>();
  constructor(private readonly source: CodingModelSource) {}

  private providers(): Provider[] {
    return this.source.settings().providers.flatMap(row => {
      const credential = this.source.secrets.credential(row.id);
      if (!credential) return [];
      const provider = (this.source.provider ?? createHostProvider)(row, credential, this.source.catalog);
      return provider ? [provider] : [];
    });
  }

  list(): { provider: string; model: string; name: string; thinking: CodingThinking[] }[] {
    return this.providers().flatMap(provider => provider.getModels().map(model =>
      ({ provider: model.provider, model: model.id, name: model.name, thinking: THINKING.filter(level => getSupportedThinkingLevels(model).includes(level)) })));
  }

  async use(requested?: ModelRef, thinking?: CodingThinking): Promise<CodingModelSelection> {
    const providers = this.providers();
    const first = providers.find(item => item.getModels().length > 0)?.getModels()[0];
    const ref = requested ?? this.source.settings().defaultModel ?? (first && { provider: first.provider, model: first.id });
    if (!ref) throw new CommandError("unavailable", "no configured coding model with credentials");
    const provider = providers.find(item => item.id === ref.provider);
    const model = provider?.getModels().find(item => item.id === ref.model);
    if (!provider || !model) throw invalid("coding model is not configured with credentials");
    const supported = THINKING.filter(level => getSupportedThinkingLevels(model).includes(level));
    const chosen = thinking ?? (supported.includes("medium") ? "medium" : supported[0] ?? "off");
    if (!supported.includes(chosen)) throw invalid("thinking level is not supported by the coding model");
    const runtime = await (this.runtime ??= ModelRuntime.create({ credentials: this.source.secrets, modelsPath: null, refreshOnCreate: false }));
    // Secrets are read through CredentialStore on every request. Re-register only when a catalog
    // entry or transport changes; the signature contains no credential value.
    const signature = JSON.stringify([provider.getModels(), this.source.secrets.credential(provider.id)?.type]);
    if (this.registered.get(provider.id) !== signature) {
      runtime.registerNativeProvider(provider);
      this.registered.set(provider.id, signature);
    }
    // Availability refresh initiated by registerNativeProvider is asynchronous. An explicit local
    // refresh isn't needed: setModel only requires hasConfiguredAuth, which also checks the store.
    return { model, runtime, thinking: chosen };
  }

  async shutdown(): Promise<void> {
    if (this.runtime) await (await this.runtime).settleCredentialWrites();
  }
}
