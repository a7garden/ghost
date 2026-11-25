import { Type, type Static } from "typebox";
import { Timestamp } from "./entities.ts";

/** The next messages the owner is likely to send, each exactly as they would type it, most likely first. Empty when suggestions are off or nothing is worth offering. */
export const NextMessageSuggestions = Type.Object({ suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 }) });
export type NextMessageSuggestions = Static<typeof NextMessageSuggestions>;

