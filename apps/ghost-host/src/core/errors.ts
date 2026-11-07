import type { ErrorCode } from "@ghost/contract";

/** A refusal the caller can understand; mapped to `{ ok: false, error }` by the API and to a tool error by the engine. */
export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export const invalid = (message: string) => new CommandError("invalid", message);
export const conflict = (message: string) => new CommandError("conflict", message);
export const forbidden = (message: string) => new CommandError("forbidden", message);
export const notFound = (message: string) => new CommandError("not_found", message);
