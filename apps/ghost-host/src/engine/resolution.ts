import type { Conversation, Ghost, ModelRef, ModelSlot, Settings, Work } from "@ghost/contract";
import { fallbackModels } from "./fallback.ts";

export function slotResolution(slot: ModelSlot | undefined): { primary: ModelRef | null; fallbacks: ModelRef[] } {
  if (!slot) return { primary: null, fallbacks: [] };
  const seen = new Set([`${slot.model.provider}/${slot.model.model}`]);
  return { primary: slot.model, fallbacks: slot.fallbacks.filter((model) => {
    const key = `${model.provider}/${model.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
}

/** Explicit overrides never silently fall back; slots carry their own fallback chain. */
export function modelResolution(settings: Settings, conversation: Conversation, ghost: Ghost, work: Work | null): { primary: ModelRef | null; fallbacks: ModelRef[] } {
  if (conversation.model) return { primary: conversation.model, fallbacks: [] };
  if (conversation.kind === "review") {
    const reviewer = work?.acceptance.reviewer ?? null;
    if (reviewer?.kind === "model") return { primary: reviewer.model, fallbacks: [] };
    if (reviewer === null && settings.reviewModel) return { primary: settings.reviewModel, fallbacks: [] };
  }
  const slotName = work && conversation.kind !== "review" ? (work.revisionsUsed > 0 && work.retry ? work.retry.slot : work.slot) : null;
  if (slotName) return slotResolution(settings.slots?.[slotName]);
  const primary = ghost.model ?? settings.defaultModel;
  return { primary, fallbacks: primary ? fallbackModels(ghost, primary, settings) : [] };
}
