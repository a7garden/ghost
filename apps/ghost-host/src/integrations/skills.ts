import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { forbidden, invalid, notFound } from "../core/errors.ts";
import type { SkillsPort } from "./ports.ts";

/** The skill name a Ghost may carry; mirrored from the contract's SkillName pattern. */
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A directory only counts as a skill when this file is present. */
const SKILL_MANIFEST = "SKILL.md";
/** One file read never exceeds this, so a stray huge file cannot stall a conversation. */
const MAX_FILE_BYTES = 64 * 1024;
/** A catalog description matches the /api/skills view bound. */
const MAX_DESCRIPTION_CHARS = 2048;
/** How long a catalog scan stays fresh; edits under the roots appear within this window. */
const CATALOG_TTL_MS = 60_000;
/** The most files one skill exposes; anything beyond is invisible to list(). */
const MAX_LISTED_FILES = 200;

interface CatalogCache {
  at: number;
  entries: { name: string; description: string }[];
}

/** `~/…` and bare `~` in configured roots expand to the owner's home directory. */
function expandRoot(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/**
 * SKILL.md front matter: a leading `---` block. Skills are written by several harnesses, so the
 * parser covers plain, quoted and `>`/`|` folded values for `description` and ignores the rest.
 */
function frontmatterOf(text: string): { body: string; description: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text, description: "" };
  let description = "";
  let folding: "fold" | "keep" | null = null;
  const folded: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (folding !== null && line.trim().length > 0) folded.push(line.trim());
      continue;
    }
    folding = null;
    const key = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(line);
    if (!key) continue;
    const value = (key[2] ?? "").trim();
    if (key[1]!.toLowerCase() !== "description") continue;
    if (value === ">" || value === ">-" || value === "|") {
      folding = value.startsWith(">") ? "fold" : "keep";
      folded.length = 0;
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      description = value.slice(1, -1).replace(/""/g, '"').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      description = value.slice(1, -1).replace(/''/g, "'");
    } else {
      description = value;
    }
  }
  if (folding !== null || folded.length > 0) description = folded.join(folding === "keep" ? "\n" : " ");
  return { body: text.slice(match[0].length).replace(/^[\r\n]+/, ""), description: description.slice(0, MAX_DESCRIPTION_CHARS) };
}

/** UTF-8 only: binary content is refused instead of producing replacement garbage. */
function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid(`${path} is not UTF-8 text`);
  }
}

function readText(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) throw invalid(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
  return decodeUtf8(readFileSync(path), path);
}

class OwnerSkills implements SkillsPort {
  private cache: CatalogCache | null = null;

  constructor(private readonly roots: string[]) {}

  /** A directory counts as a skill when it holds a bounded, UTF-8 SKILL.md; the one rule everywhere. */
  private skillAt(dir: string): { dir: string; description: string } | null {
    try {
      if (!statSync(dir).isDirectory()) return null;
      const manifest = join(dir, SKILL_MANIFEST);
      if (!statSync(manifest).isFile()) return null;
      return { dir, description: frontmatterOf(readText(manifest)).description };
    } catch {
      return null;
    }
  }

  /** The first root holding a usable `<root>/<name>`, judged exactly like the catalog scan. */
  private skillDir(name: string): string | null {
    for (const root of this.roots) {
      const found = this.skillAt(join(root, name));
      if (found !== null) return found.dir;
    }
    return null;
  }

  catalog(): { name: string; description: string }[] {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CATALOG_TTL_MS) return this.cache.entries;
    const entries = new Map<string, string>();
    for (const root of this.roots) {
      let listing: Dirent[];
      try {
        listing = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of listing) {
        // Dotfiles are never skills; symlinked skill directories (dotfile managers) are followed.
        if (entry.name.startsWith(".") || entries.has(entry.name) || !SKILL_NAME.test(entry.name)) continue;
        const found = this.skillAt(join(root, entry.name));
        if (found === null) continue;
        entries.set(entry.name, found.description);
      }
    }
    const list = [...entries].map(([name, description]) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { at: now, entries: list };
    return list;
  }

  body(name: string): string | null {
    const dir = this.skillDir(name);
    if (dir === null) return null;
    try {
      return frontmatterOf(readText(join(dir, SKILL_MANIFEST))).body;
    } catch {
      return null;
    }
  }

  list(name: string): string[] {
    const dir = this.skillDir(name);
    if (dir === null) throw notFound(`skill ${name} is not in the catalog`);
    const realDir = realpathSync(dir);
    const files: string[] = [];
    const walk = (relative: string) => {
      if (files.length >= MAX_LISTED_FILES) return;
      for (const entry of readdirSync(join(realDir, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile()) files.push(child);
        if (files.length >= MAX_LISTED_FILES) return;
      }
    };
    walk("");
    return files;
  }

  readFile(name: string, relPath: string): string {
    const dir = this.skillDir(name);
    if (dir === null) throw notFound(`skill ${name} is not in the catalog`);
    if (relPath.length === 0 || isAbsolute(relPath) || relPath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
      throw forbidden(`skill files are read by path relative to the skill directory, without dotfiles: ${relPath}`);
    }
    const realDir = realpathSync(dir);
    const path = join(realDir, ...relPath.split(/[\\/]/));
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      throw notFound(`skill ${name} has no file ${relPath}`);
    }
    if (realPath === realDir || !realPath.startsWith(realDir + sep)) throw forbidden(`${relPath} escapes skill ${name}`);
    if (!statSync(realPath).isFile()) throw invalid(`${relPath} is not a file`);
    return readText(realPath);
  }
}

/** The skills port, or null when the host has no skill roots configured. */
export function createSkills(config: Config): SkillsPort | null {
  if (config.skills === null) return null;
  return new OwnerSkills(config.skills.roots.map(expandRoot));
}
