import { createModels, fauxProvider } from "@earendil-works/pi-ai";

export function createFakeProvider(responses = []) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    models,
    modelRef: { provider: model.provider, modelId: model.id },
    streamOptions: { maxRetries: 0, maxRetryDelayMs: 0 },
    faux,
  };
}
