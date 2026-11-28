import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  APP_GHOST_TOOLS,
  ContractError,
  GhostPackage,
  Look,
  parse,
  type Command,
  type GhostPackageCatalog,
  type GhostSource,
  type Scope,
} from "@ghost/contract";
import { BUILTIN_PACKAGES } from "./builtin.ts";
import type { Core } from "../core/core.ts";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import type { SkillsPort } from "../integrations/ports.ts";

/** One file read never exceeds this, so a stray huge file cannot stall a catalog scan. */
const MAX_FILE_BYTES = 64 * 1024;
/** A directory only counts as an owner package when this file is present. */
const MANIFEST = "GHOST.md";
/** How long a catalog scan stays fresh; edits under the root appear within this window. */
const CATALOG_TTL_MS = 60_000;
/** Owner package directories follow the same name rule as skills (SkillName). */
const DIR_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A leading `---` block of YAML front matter; the body after it is the persona. */
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The delegation rule of the 3.0 hierarchy, shared by works.ts. */
export const INSTALLED_DELEGATION_RULE = "Installed Ghosts delegate only to themselves or the main Ghost; hand other work to the main Ghost";

interface PackageCache {
  at: number;
  packages: GhostPackage[];
  errors: { path: string; message: string }[];
}

/** True when `.git` exists at or above `path`; the walk stops at the filesystem root. */
function inGitWorkTree(path: string): boolean {
  let current = path;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Which of the main Ghost's scopes a package offers to take at install: only scopes the main Ghost
 * receives (ghostId null or the main id). `code` takes scopes inside a git work tree; `documents`
 * takes vault scopes outside one; a package without projects takes none.
 */
export function suggestedScopeIds(pkg: GhostPackage, scopes: readonly Scope[], mainGhostId: string): string[] {
  if (pkg.projects === null) return [];
  const received = scopes.filter((scope) => scope.ghostId === null || scope.ghostId === mainGhostId);
  const matches =
    pkg.projects === "code"
      ? (scope: Scope) => scope.paths.some((path) => inGitWorkTree(path))
      : (scope: Scope) => scope.vaultPath !== null && !scope.paths.some((path) => inGitWorkTree(path));
  return received.filter(matches).map((scope) => scope.id);
}

/** The owner-written look: only body, shape, face and mark; the avatar stays null. */
function ownerLook(value: unknown): Look {
  const look: Look = { avatarId: null };
  if (value === undefined || value === null) return look;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid(`${MANIFEST} look must be a mapping of body, shape, face and mark`);
  const fields = value as Record<string, unknown>;
  for (const key of ["body", "shape", "face", "mark"] as const) {
    const item = fields[key];
    if (item !== undefined && item !== null) (look as Record<string, unknown>)[key] = item;
  }
  return look;
}

/** One `<root>/<name>/GHOST.md`, or null when the directory holds no manifest. Anything broken throws. */
function ownerPackage(path: string, expectedName: string): GhostPackage | null {
  let bytes: Uint8Array;
  try {
    const info = statSync(path);
    if (!info.isFile()) return null;
    if (info.size > MAX_FILE_BYTES) throw invalid(`${MANIFEST} is larger than ${MAX_FILE_BYTES} bytes`);
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid(`${MANIFEST} is not UTF-8 text`);
  }
  const match = FRONT_MATTER.exec(text);
  if (match === null) throw invalid(`${MANIFEST} must start with a --- front matter block`);
  let matter: unknown;
  try {
    matter = parseYaml(match[1]!);
  } catch (error) {
    throw invalid(`${MANIFEST} front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (matter === null) matter = {};
  if (typeof matter !== "object" || Array.isArray(matter)) throw invalid(`${MANIFEST} front matter must be a mapping`);
  const fields = matter as Record<string, unknown>;
  // The YAML values are untyped until the contract schema judges them; parse() reports every issue.
  const candidate: unknown = {
    name: fields.name,
    title: fields.title,
    version: fields.version,
    origin: "owner",
    persona: text.slice(match[0].length).trim(),
    look: ownerLook(fields.look),
    tools: fields.tools == null ? [...APP_GHOST_TOOLS] : fields.tools,
    skills: fields.skills == null ? [] : fields.skills,
    hostExecution: fields.hostExecution == null ? false : fields.hostExecution,
    modelHint: fields.modelHint == null ? "" : fields.modelHint,
    projects: fields.projects == null ? null : fields.projects,
  };
  if (fields.name !== expectedName) throw invalid(`${MANIFEST} name must equal the directory name ${expectedName}`);
  try {
    return parse(GhostPackage, candidate);
  } catch (error) {
    if (error instanceof ContractError) throw invalid(`${MANIFEST} is not a valid Ghost package: ${error.message}`);
    throw error;
  }
}

/**
 * Every installable package: the built-ins that ship with the Host plus the owner's `GHOST.md`
 * files under the packages root. A file that fails to load becomes an `errors` entry instead of
 * hiding the rest; an owner package reusing a built-in name loses to the built-in.
 */
export class GhostPackages {
  private cache: PackageCache | null = null;

  constructor(private readonly root: string | null) {}

  list(): { packages: GhostPackage[]; errors: { path: string; message: string }[] } {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CATALOG_TTL_MS) return this.cache;
    const packages: GhostPackage[] = BUILTIN_PACKAGES.map((pkg) => ({ ...pkg, origin: "builtin" as const }));
    const errors: { path: string; message: string }[] = [];
    const names = new Set(packages.map((pkg) => pkg.name));
    if (this.root !== null) {
      // A missing root simply means no owner packages; other read problems surface per file.
      let listing: Dirent[] = [];
      try {
        listing = readdirSync(this.root, { withFileTypes: true });
      } catch {
        listing = [];
      }
      for (const entry of listing.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.name.startsWith(".") || !DIR_NAME.test(entry.name)) continue;
        const path = join(this.root, entry.name, MANIFEST);
        try {
          const pkg = ownerPackage(path, entry.name);
          if (pkg === null) continue;
          if (names.has(pkg.name)) {
            errors.push({ path, message: `a built-in package already uses the name ${pkg.name}; the built-in one wins` });
            continue;
          }
          names.add(pkg.name);
          packages.push(pkg);
        } catch (error) {
          errors.push({ path, message: error instanceof CommandError ? error.message : `${path} could not be read` });
        }
      }
    }
    this.cache = { at: now, packages, errors };
    return this.cache;
  }

  /** One package by name; built-ins win over a clashing owner file. */
  get(name: string): GhostPackage {
    const builtin = BUILTIN_PACKAGES.find((pkg) => pkg.name === name);
    if (builtin) return { ...builtin, origin: "builtin" };
    const owner = this.root === null ? undefined : this.list().packages.find((pkg) => pkg.origin === "owner" && pkg.name === name);
    if (owner) return owner;
    throw notFound(`no Ghost package named ${name} is available on this Host`);
  }
}

/** A ghost.create with every package field made explicit, plus the source it records. */
export interface ResolvedGhostCreate {
  /** `name` and `persona` are always filled: from the package when the caller omitted them. */
  command: ResolvedGhostCreateCommand;
  source: GhostSource | null;
}

/** A ghost.create whose package was resolved away into explicit required fields. */
export type ResolvedGhostCreateCommand = Omit<Extract<Command, { type: "ghost.create" }>, "name" | "persona"> & { name: string; persona: string };

/**
 * The single creation rule set, shared by the owner's `ghost.create` command and the main Ghost's
 * `ghost_create` tool. Installing a package fills every omitted field from it and refuses a second
 * Ghost from the same package; by hand, name and persona are required. Names are unique among
 * non-deleted Ghosts on both paths.
 */
export function resolveGhostCreate(core: Core, command: Extract<Command, { type: "ghost.create" }>): ResolvedGhostCreate {
  const living = core.ledger.ghosts().filter((ghost) => ghost.deletedAt === null);
  const givenName = command.name?.trim();
  const givenPersona = command.persona?.trim();
  let name: string;
  let persona: string;
  let look = command.look;
  let tools = command.tools;
  let skills = command.skills;
  let hostExecution = command.hostExecution;
  let source: GhostSource | null = null;
  if (command.package !== undefined) {
    const pkg = core.packages.get(command.package);
    const installed = living.find((ghost) => (ghost.source ?? null)?.package === pkg.name);
    if (installed) throw conflict(`the package ${pkg.title} (${pkg.name}) is already installed as ${installed.name}; work with ${installed.name} or remove it first`);
    name = givenName === undefined || givenName === "" ? pkg.title : givenName;
    persona = givenPersona === undefined || givenPersona === "" ? pkg.persona : givenPersona;
    look ??= pkg.look;
    tools ??= pkg.tools;
    skills ??= pkg.skills;
    hostExecution ??= pkg.hostExecution;
    source = { package: pkg.name, version: pkg.version };
  } else {
    if (givenName === undefined || givenName === "") throw invalid("a Ghost made by hand needs a name");
    if (givenPersona === undefined || givenPersona === "") throw invalid("a Ghost made by hand needs a persona");
    name = givenName;
    persona = givenPersona;
  }
  if (living.some((ghost) => ghost.name === name)) throw conflict(`a Ghost named ${name} already exists`);
  return {
    command: {
      type: "ghost.create",
      name,
      persona,
      ...(command.model === undefined ? {} : { model: command.model }),
      ...(look === undefined ? {} : { look }),
      ...(tools === undefined ? {} : { tools }),
      ...(command.fallbacks === undefined ? {} : { fallbacks: command.fallbacks }),
      ...(skills === undefined ? {} : { skills }),
      ...(hostExecution === undefined ? {} : { hostExecution }),
      ...(command.attachments === undefined ? {} : { attachments: command.attachments }),
    },
    source,
  };
}

/** GET /api/ghost-packages and the main Ghost's `ghost_packages` tool: the catalog as it applies here. */
export function ghostPackageCatalog(core: Core, skills: SkillsPort | null): GhostPackageCatalog {
  const { packages, errors } = core.packages.list();
  const living = core.ledger.ghosts().filter((ghost) => ghost.deletedAt === null);
  const main = core.ledger.defaultGhost();
  const scopes = main === null ? [] : core.ledger.scopes().filter((scope) => scope.ghostId === null || scope.ghostId === main.id);
  const known = new Set((skills?.catalog() ?? []).map((skill) => skill.name));
  return {
    packages: packages.slice(0, 256).map((pkg) => ({
      ...pkg,
      installedGhostId: living.find((ghost) => (ghost.source ?? null)?.package === pkg.name)?.id ?? null,
      suggestedScopeIds: suggestedScopeIds(pkg, scopes, main === null ? "" : main.id).slice(0, 256),
      missingSkills: skills === null ? [...pkg.skills] : pkg.skills.filter((name) => !known.has(name)),
    })),
    errors: errors.slice(0, 256),
  };
}
