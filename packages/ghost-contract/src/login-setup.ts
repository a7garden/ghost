import { Type, type Static } from "typebox";
import { Id, nullable } from "./entities.ts";

/** GET /api/connect/mail?email= — how an address connects, resolved by the Host. Never carries secrets. */
export const MailDiscovery = Type.Object({
  email: Type.String({ maxLength: 320 }),
  domain: Type.String({ maxLength: 253 }),
  /** The catalog service this address belongs to (`gmail`, `icloud`, `outlook`, …); null for an unknown domain. */
  provider: nullable(Type.Object({ id: Type.String({ maxLength: 64 }), name: Type.String({ maxLength: 128 }) })),
  /** Implicit-TLS IMAP only: the one mode the Host mail client speaks. Null when no such server was found. */
  imap: nullable(Type.Object({ host: Type.String({ maxLength: 253 }), port: Type.Integer({ minimum: 1, maximum: 65535 }) })),
  smtp: nullable(Type.Object({ host: Type.String({ maxLength: 253 }), port: Type.Integer({ minimum: 1, maximum: 65535 }), secure: Type.Boolean() })),
  /** `oauth`: sign in through the provider (Gmail, Outlook); `app_password`: a provider-issued app password; `password`: the account password. */
  auth: Type.Union([Type.Literal("oauth"), Type.Literal("app_password"), Type.Literal("password")]),
  /** Where the owner creates the app password or enables IMAP; null when the provider needs nothing. */
  setupUrl: nullable(Type.String({ maxLength: 2048 })),
  /** One short sentence about a provider prerequisite (turn IMAP on, 2-step verification); null when none. */
  note: nullable(Type.String({ maxLength: 256 })),
  source: Type.Union([Type.Literal("known"), Type.Literal("autoconfig"), Type.Literal("mx"), Type.Literal("guess"), Type.Literal("none")]),
});
export type MailDiscovery = Static<typeof MailDiscovery>;

/** An account already signed in on the Host's own Mac that can become a connection with one click (GitHub CLI). */
export const LocalAccount = Type.Object({
  source: Type.Literal("gh"),
  serviceId: Type.String({ maxLength: 64 }),
  /** Account name on the service. */
  login: Type.String({ maxLength: 128 }),
  /** Permissions the Mac's sign-in already holds; shown before the owner reuses it. */
  scopes: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 }),
  /** The connection that already uses this account, or null when it is not connected yet. */
  connectionId: nullable(Id),
});
export type LocalAccount = Static<typeof LocalAccount>;

/** POST /api/connect/local — reuse one local account. The token never leaves the Host. */
export const LocalAccountConnect = Type.Object({
  source: Type.Literal("gh"),
  login: Type.String({ minLength: 1, maxLength: 128 }),
});
export type LocalAccountConnect = Static<typeof LocalAccountConnect>;

/**
 * Shade (the owner's separate password app) as seen from the Host's `shade` CLI.
 * `unavailable`: CLI missing or the app unreachable · `locked`: vault locked · `agent_off`: the owner has not
 * enabled agent access in Shade · `ready`: logins can be looked up. Metadata only; values never cross this API.
 */
export const ShadeState = Type.Union([Type.Literal("unavailable"), Type.Literal("locked"), Type.Literal("agent_off"), Type.Literal("ready")]);
export type ShadeState = Static<typeof ShadeState>;

export const ShadeStatus = Type.Object({
  state: ShadeState,
  /** Shade also lets agents add items (owner setting inside Shade). */
  writable: Type.Boolean(),
  /** Host preference: a login the owner types in a handoff is also saved to Shade. Effective only when `writable`. */
  saveLogins: Type.Boolean(),
});
export type ShadeStatus = Static<typeof ShadeStatus>;

export const ShadeLogin = Type.Object({
  id: Type.String({ maxLength: 64 }),
  title: Type.String({ maxLength: 256 }),
  username: Type.String({ maxLength: 512 }),
  origin: Type.String({ maxLength: 512 }),
});
export type ShadeLogin = Static<typeof ShadeLogin>;

/** One saved login that can fill the page the owner is on. Metadata only. */
export const LoginChoice = Type.Object({
  id: Id,
  title: Type.String({ maxLength: 256 }),
  username: nullable(Type.String({ maxLength: 512 })),
  hasPassword: Type.Boolean(),
  hasTotp: Type.Boolean(),
});
export type LoginChoice = Static<typeof LoginChoice>;

/**
 * GET /api/browser/sessions/:conversationId/login — what the handoff card offers for the page the owner is on.
 * `items` are the Ghost vault logins granted to this session's Ghost for exactly this origin; `shade` lists
 * matching Shade logins that are not imported yet (empty unless Shade is ready).
 */
export const BrowserLoginShelf = Type.Object({
  origin: nullable(Type.String({ maxLength: 512 })),
  /**
   * A login the Host saw the owner complete in this session, since the pending handoff began; null until then.
   * `created`: the vault gained or changed this login just now (false when it was already saved and only used).
   * `shade`: Shade also holds it.
   */
  saved: nullable(Type.Object({ itemId: Id, username: Type.String({ maxLength: 512 }), origin: Type.String({ maxLength: 512 }), at: Type.Integer(), created: Type.Boolean(), shade: Type.Boolean() })),
  items: Type.Array(LoginChoice, { maxItems: 32 }),
  shade: Type.Object({ status: ShadeStatus, items: Type.Array(ShadeLogin, { maxItems: 32 }) }),
});
export type BrowserLoginShelf = Static<typeof BrowserLoginShelf>;

/** POST /api/browser/sessions/:conversationId/fill — type one saved field into the focused page field, as the owner would. */
export const BrowserLoginFill = Type.Object({
  itemId: Id,
  field: Type.Union([Type.Literal("username"), Type.Literal("password"), Type.Literal("totp")]),
});
export type BrowserLoginFill = Static<typeof BrowserLoginFill>;
