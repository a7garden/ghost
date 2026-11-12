import { defineDoc } from "@earendil-works/pi-durable";

/** Creation and the call-to-child mapping share one Pi commit, including crash recovery. */
export const HelpersDoc = defineDoc({
  kind: "ghost.helpers", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): { byCall: Record<string, number> } => ({ byCall: {} }),
});

/** Promotion is atomic with the passive assistant entry in the owner's transcript. */
export const WakeRepliesDoc = defineDoc({
  kind: "ghost.wake-replies", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): { byWake: Record<string, true> } => ({ byWake: {} }),
});
