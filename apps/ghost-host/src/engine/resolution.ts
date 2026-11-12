import type { Conversation, Ghost, ModelRef, Settings, Work } from "@ghost/contract";
import { fallbackModels } from "./fallback.ts";

/** Explicit overrides never silently fall back; slots carry their own fallback chain. */
export function modelResolution(settings: Settings, conversation: Conversation, ghost: Ghost, work: Work | null): { primary: ModelRef | null; fallbacks: ModelRef[] } {
  if (conversation.model) return { primary: conversation.model, fallbacks: [] };
  if (conversation.kind === "review") {
    const reviewer = work?.acceptance.reviewer ?? null;
    if (reviewer?.kind === "model") return { primary: reviewer.model, fallbacks: [] };
    if (reviewer === null && settings.reviewModel) return { primary: settings.reviewModel, fallbacks: [] };
  }
  const slotName = work && conversation.kind !== "review" ? (work.revisionsUsed > 0 && work.retry ? work.retry.slot : work.slot) : null;
  if (slotName) {
    const slot = settings.slots[slotName];
    if (!slot) return { primary: null, fallbacks: [] };
    return { primary: slot.model, fallbacks: slot.fallbacks };
  }
  const primary = ghost.model ?? settings.defaultModel;
  return { primary, fallbacks: primary ? fallbackModels(ghost, primary, settings) : [] };
}
