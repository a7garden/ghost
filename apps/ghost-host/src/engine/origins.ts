import type { ArtifactRef, MessageOrigin } from "@ghost/contract";
import { defineDoc } from "@earendil-works/pi-durable";

/** What the host recorded for one submitted input. */
export type OriginRecord = {
  origin: MessageOrigin;
  attachments: ArtifactRef[];
};

/**
 * Origins of user messages, keyed by the host request id.
 *
 * Pi keeps the request id on the submission, never on the transcript entry, so the
 * engine writes this document before it admits the input: the origin is durable
 * before the message exists, and a crash can only leave a record for an input that
 * was never admitted. The entry is found again through the submission that placed
 * it, so a restarted host reads the same origin back.
 */
export const OriginsDoc = defineDoc<{ byRequest: Record<string, OriginRecord> }>({
  kind: "ghost.origins",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byRequest: {} }),
});
