import { Type, type Static } from "typebox";
import { CodingThinking } from "./coding-session.ts";

const exact = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 400 });
const bool = Type.Boolean();
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const mode = Type.Union([Type.Literal("one-at-a-time"), Type.Literal("all")]);
const fields = {
  model: Type.Union([Type.Object({ provider: text, model: text }, exact), Type.Null()]),
  thinking: Type.Union([CodingThinking, Type.Null()]),
  steeringMode: mode,
  followUpMode: mode,
  // Null means Ghost's built-ins and the default-active tools from enabled extensions.
  toolAllowlist: Type.Union([Type.Array(Type.String({ pattern: "^[A-Za-z0-9_][A-Za-z0-9_:.\\/-]{0,199}$" }), { maxItems: 256, uniqueItems: true }), Type.Null()]),
  imageAutoResize: bool,
};
const compaction = Type.Object({ enabled: bool, reserveTokens: count, keepRecentTokens: count }, exact);
const retry = Type.Object({ enabled: bool, maxRetries: Type.Integer({ minimum: 0, maximum: 100 }), baseDelayMs: count }, exact);

export const PiSettings = Type.Object({ ...fields, compaction, retry }, exact);
export type PiSettings = Static<typeof PiSettings>;
export const PiSettingsOverrides = Type.Partial(Type.Object({
  ...fields, compaction: Type.Partial(compaction), retry: Type.Partial(retry),
}), exact);
export type PiSettingsOverrides = Static<typeof PiSettingsOverrides>;

export const PiPackageFlags = Type.Object({ extensions: bool, skills: bool, prompts: bool }, exact);
export type PiPackageFlags = Static<typeof PiPackageFlags>;
export const PiPackageOverrides = Type.Partial(PiPackageFlags, exact);
export type PiPackageOverrides = Static<typeof PiPackageOverrides>;
export const PiInstall = Type.Object({ source: Type.String({ minLength: 1, maxLength: 4096 }), confirmed: Type.Literal(true) }, exact);
export type PiInstall = Static<typeof PiInstall>;

export interface PiPackage {
  id: string;
  name: string;
  source: string;
  version: string | null;
  enabled: PiPackageFlags;
  extensions: string[];
  skills: string[];
  prompts: string[];
  tools: string[];
  commands: string[];
  error: string | null;
}

export interface PiContextUsage { tokens: number | null; contextWindow: number; percent: number | null }
export interface PiSessionConfig {
  defaults: PiSettings;
  overrides: PiSettingsOverrides;
  packages: PiPackage[];
  packageOverrides: Record<string, PiPackageOverrides>;
  context: PiContextUsage | null;
  imageResizeAvailable: boolean;
  /** Only owner-started sessions load installed resources. */
  resourcesAllowed: boolean;
  /** Includes the tool names built into the session and discovered extension tools. */
  tools: string[];
}

export const PiSessionConfigUpdate = Type.Object({ overrides: PiSettingsOverrides }, exact);
