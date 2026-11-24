import { Type, type Static } from "typebox";
import { Timestamp } from "./entities.ts";

/** The next messages the owner is likely to send, each exactly as they would type it, most likely first. Empty when suggestions are off or nothing is worth offering. */
export const NextMessageSuggestions = Type.Object({ suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 }) });
export type NextMessageSuggestions = Static<typeof NextMessageSuggestions>;

/**
 * What omp offers for starting a session in a directory, for the start form: the models it can use (`omp models`) with
 * the thinking levels each supports, and the directory's most recent conversations to continue (`omp --resume <id>`).
 */
export const OmpInfo = Type.Object({
  models: Type.Array(Type.Object({ selector: Type.String(), name: Type.String(), provider: Type.String(), thinking: Type.Array(Type.String()) })),
  sessions: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), updatedAt: Timestamp })),
});
export type OmpInfo = Static<typeof OmpInfo>;
