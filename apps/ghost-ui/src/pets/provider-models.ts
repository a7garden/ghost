import type { ModelInfo } from '@ghost/contract';

/** Stored entries keep their position; current catalog metadata wins for known IDs. */
export function mergeModels(selected: ModelInfo[], catalog: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const latest = new Map(catalog.map(model => [model.id, model]));
  const merged: ModelInfo[] = [];
  for (const model of [...selected, ...catalog]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(latest.get(model.id) ?? model);
  }
  return merged;
}

/**
 * Checks (`checked`) or unchecks one model on the full selection, so entries the search has
 * filtered out of view stay untouched. Ids compare exactly — `org/mini` and `mini` differ.
 * When adding, an already-selected id keeps its saved entry; otherwise `model` is appended.
 */
export function toggleModel(selected: ModelInfo[], model: ModelInfo, checked: boolean): ModelInfo[] {
  if (!checked) return selected.filter(entry => entry.id !== model.id);
  return selected.some(entry => entry.id === model.id) ? selected : [...selected, model];
}
