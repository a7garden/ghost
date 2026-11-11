import { Type, type Static } from "typebox";
import { Id, nullable } from "./entities.ts";

/** Built-in services the Host can complete with a real OAuth login; everything else stays a manual paste. */
export const ConnectionOAuthServiceId = Type.Union([
  Type.Literal("google"),
  Type.Literal("outlook"),
  Type.Literal("x"),
  Type.Literal("notion"),
  Type.Literal("slack"),
]);
export type ConnectionOAuthServiceId = Static<typeof ConnectionOAuthServiceId>;

export const ConnectionOAuthState = Type.Union([
  Type.Literal("idle"),
  Type.Literal("pending"),
  Type.Literal("connected"),
  Type.Literal("error"),
]);
export type ConnectionOAuthState = Static<typeof ConnectionOAuthState>;

/** GET /api/connection-oauth/:service. Brief client/login status; never carries secrets or provider error text. */
export const ConnectionOAuthView = Type.Object({
  serviceId: ConnectionOAuthServiceId,
  /** False until the owner saved the provider's client app registration. */
  configured: Type.Boolean(),
  clientId: nullable(Type.String({ maxLength: 256 })),
  redirectUri: Type.String({ minLength: 1, maxLength: 2048 }),
  state: ConnectionOAuthState,
  /** The provider consent URL while `pending`; null otherwise. */
  authorizationUrl: nullable(Type.String({ maxLength: 2048 })),
  connectionId: nullable(Id),
  /** Bounded host wording; provider error bodies are never echoed. */
  message: nullable(Type.String({ maxLength: 512 })),
});
export type ConnectionOAuthView = Static<typeof ConnectionOAuthView>;

/** PUT /api/connection-oauth/:service. The owner's OAuth app registration; the secret is stored 0600 outside the ledger. */
export const ConnectionOAuthClientInput = Type.Object({
  clientId: Type.String({ minLength: 1, maxLength: 256, pattern: "^[\\x21-\\x7E]+$" }),
  /** Omit to keep the stored secret for the same client; explicit null clears it. Never returned to clients. */
  clientSecret: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 512, pattern: "^[\\x21-\\x7E]+$" }))),
});
export type ConnectionOAuthClientInput = Static<typeof ConnectionOAuthClientInput>;

/** POST /api/connection-oauth/:service. Starts one real authorization-code + PKCE login. */
export const ConnectionOAuthStart = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128 }),
  /** Ghosts granted the registered connection; re-checked live when the callback completes. */
  ghostIds: Type.Optional(Type.Array(Id, { maxItems: 256, uniqueItems: true })),
  /** Full account address; required for the Outlook mail login, ignored elsewhere. */
  username: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
  /** Google only: also grant `drive.readonly` alongside the identity scopes. Default false. */
  googleDrive: Type.Optional(Type.Boolean()),
});
export type ConnectionOAuthStart = Static<typeof ConnectionOAuthStart>;
