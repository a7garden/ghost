import { cp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, SettingsManager, loadSkills, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { PiInstall, PiPackage, PiPackageFlags, PiPackageOverrides } from "@ghost/contract";
import { conflict, invalid, notFound } from "../core/errors.ts";
import { newId } from "../core/ids.ts";
import type { Ledger } from "../ledger/ledger.ts";

const OFF: PiPackageFlags = { extensions: false, skills: false, prompts: false };
const KINDS = ["extensions", "skills", "prompts"] as const;
type Paths = Record<typeof KINDS[number], string[]>;
type Installed = { item: PiPackage; paths: Paths };

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

export interface PiResources {
  entries: Installed[];
  additionalExtensionPaths: string[];
  additionalSkillPaths: string[];
  additionalPromptTemplatePaths: string[];
}

export class PiExtensions {
  private readonly directory: string;
  private readonly installing = new Set<string>();

  constructor(root: string, private readonly ledger: Ledger) { this.directory = join(root, "pi", "packages"); }

  private installed(): Installed[] { return this.ledger.setting("pi.packages", []); }
  private store(rows: Installed[]): void { this.ledger.putSetting("pi.packages", rows); }
  list(): PiPackage[] { return this.installed().map(row => row.item); }

  overrides(id: string): Record<string, PiPackageOverrides> {
    const stored = this.ledger.setting<Record<string, PiPackageOverrides>>(`pi.session.packages:${id}`, {});
    return Object.fromEntries(this.installed().flatMap(({ item }) => {
      const flags = stored[item.id];
      return flags ? [[item.id, flags]] : [];
    }));
  }

  setFlags(packageId: string, enabled: PiPackageFlags): PiPackage {
    const rows = this.installed();
    const row = rows.find(row => row.item.id === packageId);
    if (!row) throw notFound("설치된 Pi 패키지가 없습니다.");
    row.item.enabled = enabled;
    this.store(rows);
    return row.item;
  }

  setOverrides(sessionId: string, packageId: string, flags: PiPackageOverrides): Record<string, PiPackageOverrides> {
    if (!this.installed().some(row => row.item.id === packageId)) throw notFound("설치된 Pi 패키지가 없습니다.");
    const overrides = this.overrides(sessionId);
    if (Object.keys(flags).length) overrides[packageId] = flags;
    else delete overrides[packageId];
    this.ledger.putSetting(`pi.session.packages:${sessionId}`, overrides);
    return overrides;
  }

  async install(input: PiInstall): Promise<PiPackage> {
    // Only the authenticated owner API calls this installer. npm and git can run
    // lifecycle scripts on installation; no Ghost tool may grant Host code execution.
    if (input.confirmed !== true) throw invalid("설치 권한 확인이 필요합니다.");
    const entered = input.source.trim();
    if (!entered || entered.startsWith("-") || entered.startsWith("builtin:") || entered.includes("\0")) throw invalid("Pi 설치 경로가 올바르지 않습니다.");
    const localPath = resolve(entered.startsWith("~/") ? join(homedir(), entered.slice(2)) : entered);
    const remote = /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(entered);
    const disk = remote ? null : await realpath(localPath).catch(() => null);
    const source = remote ? (entered.startsWith("git@") ? `git:${entered}` : entered) : disk ?? `npm:${entered}`;
    if (!remote && !disk && /^(?:[./~]|[^@\s]+\/)/.test(entered)) throw invalid("로컬 설치 경로를 찾을 수 없습니다.");
    // Pi passes the npm spec as an argv entry. Accept names/ranges, not npm flags
    // or path/URL aliases that may install outside the managed package root.
    if (source.startsWith("npm:") && !/^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*+^~<>=| -]+)?$/i.test(source)) {
      throw invalid("npm 패키지 이름과 버전을 입력하세요.");
    }
    if (this.installing.has(source) || this.installed().some(row => row.item.source === source)) throw conflict("이미 설치된 Pi 패키지입니다.");
    this.installing.add(source);
    const id = `pi-${newId()}`;
    const directory = join(this.directory, id);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const manager = new DefaultPackageManager({ cwd: directory, agentDir: directory, commandOutput: "capture",
        settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false, npmCommand: ["npm", "--cache", join(this.directory, "..", "npm-cache")] }),
      });
      let root: string;
      if (disk) {
        const info = await stat(disk);
        if (!info.isDirectory() && !info.isFile()) throw invalid("파일 또는 폴더를 선택하세요.");
        if (inside(disk, directory)) throw invalid("Pi 설치 폴더를 포함하는 경로는 설치할 수 없습니다.");
        root = join(directory, basename(disk));
        // Snapshot local code: editing the original checkout must not replace code the owner approved.
        await cp(disk, root, { recursive: true, dereference: true, filter: async path => {
          const target = await realpath(path);
          if (!inside(disk, target)) throw invalid("설치 폴더 밖을 가리키는 링크가 있습니다.");
          return true;
        } });
        await manager.install(root);
      } else {
        await manager.install(source);
        const path = manager.getInstalledPath(source, "user");
        if (!path) throw invalid("설치된 Pi 패키지 경로를 찾을 수 없습니다.");
        root = await realpath(path);
        if (!inside(directory, root)) throw invalid("Pi 패키지가 Host 상태 폴더 밖에 설치되었습니다.");
      }
      const folder = (await stat(root)).isDirectory();
      const resolved = await manager.resolveExtensionSources([root]);
      const paths = Object.fromEntries(await Promise.all(KINDS.map(async kind => [kind,
        await Promise.all(resolved[kind].filter(entry => entry.enabled).map(async entry => {
          const path = await realpath(entry.path);
          if (!inside(directory, path)) throw invalid("Pi 리소스가 설치 폴더 밖을 가리킵니다.");
          return path;
        })),
      ]))) as Paths;
      const skillFile = folder ? join(root, "SKILL.md") : root;
      if (basename(skillFile) === "SKILL.md" && (await stat(skillFile).catch(() => null))?.isFile()) {
        const actual = await realpath(skillFile);
        if (!inside(directory, actual)) throw invalid("스킬 파일이 설치 폴더 밖을 가리킵니다.");
        paths.extensions = paths.extensions.filter(path => path !== root);
        paths.skills = [...new Set([...paths.skills, actual])];
      } else if (!folder && extname(root).toLowerCase() === ".md") {
        paths.extensions = [];
        paths.prompts = [root];
      }
      if (folder && paths.extensions.includes(root)) {
        paths.extensions = [];
        for (const name of ["index.ts", "index.js"]) {
          const entry = join(root, name);
          if (!(await stat(entry).catch(() => null))?.isFile()) continue;
          const actual = await realpath(entry);
          if (!inside(directory, actual)) throw invalid("확장 파일이 설치 폴더 밖을 가리킵니다.");
          paths.extensions = [actual];
          break;
        }
      }
      if (!KINDS.some(kind => paths[kind].length)) throw invalid("Pi 확장, 스킬 또는 프롬프트 템플릿을 찾을 수 없습니다.");
      let manifest: { name?: unknown; version?: unknown } = {};
      if (folder) {
        try { manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { /* Optional for standalone resources. */ }
      }
      const item: PiPackage = {
        id, source, name: typeof manifest?.name === "string" ? manifest.name : basename(root),
        version: typeof manifest?.version === "string" ? manifest.version : null, enabled: { ...OFF },
        extensions: paths.extensions.map(path => relative(folder ? root : dirname(root), path)),
        skills: loadSkills({ cwd: directory, agentDir: directory, skillPaths: paths.skills, includeDefaults: false }).skills.map(skill => skill.name),
        prompts: paths.prompts.map(path => basename(path, extname(path))), tools: [], commands: [], error: null,
      };
      this.store([...this.installed(), { item, paths }]);
      return item;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw invalid(error instanceof Error ? error.message : String(error));
    } finally { this.installing.delete(source); }
  }

  async remove(id: string): Promise<void> {
    const rows = this.installed();
    if (!rows.some(row => row.item.id === id)) throw notFound("설치된 Pi 패키지가 없습니다.");
    this.store(rows.filter(row => row.item.id !== id));
    await rm(join(this.directory, id), { recursive: true, force: true });
  }

  resources(sessionId: string): PiResources {
    const rows = this.installed();
    const overrides = this.overrides(sessionId);
    const selected = (kind: keyof Paths) => rows.flatMap(row => ({ ...row.item.enabled, ...overrides[row.item.id] })[kind] ? row.paths[kind] : []);
    const additionalExtensionPaths = selected("extensions");
    return { entries: rows.filter(row => row.paths.extensions.some(path => additionalExtensionPaths.includes(path))), additionalExtensionPaths,
      additionalSkillPaths: selected("skills"), additionalPromptTemplatePaths: selected("prompts") };
  }

  observe(selection: PiResources, loader: DefaultResourceLoader): void {
    const { extensions, errors } = loader.getExtensions();
    for (const { item } of selection.entries) {
      const root = join(this.directory, item.id);
      const loaded = extensions.filter(entry => inside(root, entry.resolvedPath));
      this.record(item.id, {
        tools: [...new Set(loaded.flatMap(entry => [...entry.tools.keys()]))].sort(),
        commands: [...new Set(loaded.flatMap(entry => [...entry.commands.keys()]))].sort(),
        error: errors.filter(entry => inside(root, entry.path)).map(entry => entry.error).join("\n").slice(0, 4000) || null,
      });
    }
  }

  runtimeError(selection: PiResources, event: unknown): void {
    if (!event || typeof event !== "object" || !("extensionPath" in event) || typeof event.extensionPath !== "string" || !("error" in event)) return;
    const path = event.extensionPath;
    const row = selection.entries.find(({ item }) => inside(join(this.directory, item.id), path));
    if (row) this.record(row.item.id, { error: String(event.error).slice(0, 4000) });
  }

  private record(id: string, patch: Partial<PiPackage>): void {
    const rows = this.installed();
    const row = rows.find(row => row.item.id === id);
    if (!row) return;
    const next = { ...row.item, ...patch };
    if (JSON.stringify(next) === JSON.stringify(row.item)) return;
    row.item = next;
    this.store(rows);
  }
}

/** Read access for enabled skill files and their support files, not their installation as a whole. */
export function installedSkillPath(path: string, files: readonly { filePath: string; baseDir: string }[]): string | null {
  if (!isAbsolute(path)) return null;
  try {
    const actual = realpathSync(path);
    return files.some(skill => actual === skill.filePath || (basename(skill.filePath) === "SKILL.md" && inside(skill.baseDir, actual))) ? actual : null;
  } catch { return null; }
}
