import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { validate, type OmpInfo } from "@ghost/contract";
import { CommandError, invalid } from "../core/errors.ts";
import { findProgram } from "./herdr.ts";

const Models = Type.Object({
  models: Type.Array(Type.Object({
    provider: Type.String(),
    kind: Type.Optional(Type.String()),
    selector: Type.String(),
    name: Type.Optional(Type.String()),
    // Null for a model that does not think.
    thinking: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  })),
});

const MODELS_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 15;
/** The head of a session file holds its title and id; the rest is the whole conversation. */
const HEAD_BYTES = 8 * 1024;

/**
 * What omp offers for starting a session, read from omp itself: its models (`omp models --json`, cached ten minutes)
 * and the conversations it keeps per directory. Only reads; nothing here starts or changes anything.
 */
export class OmpInfoProvider {
  private cache: { at: number; models: OmpInfo["models"] } | null = null;

  constructor(private readonly options: { executable?: string | null; sessionsRoot?: string; home?: string } = {}) {}

  private get executable(): string | null {
    return this.options.executable !== undefined ? this.options.executable : findProgram("omp");
  }

  private async models(): Promise<OmpInfo["models"]> {
    if (this.cache !== null && Date.now() - this.cache.at < MODELS_TTL_MS) return this.cache.models;
    const executable = this.executable;
    if (executable === null) return [];
    const child = Bun.spawn([executable, "models", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { HOME: process.env.HOME ?? homedir(), PATH: `${dirname(executable)}:/usr/bin:/bin` } });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      const out = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) return [];
      const parsed: unknown = JSON.parse(out);
      if (!validate(Models, parsed)) return [];
      const models = parsed.models
        .filter((model) => model.kind === undefined || model.kind === "chat")
        .map((model) => ({ selector: model.selector, name: model.name ?? model.selector, provider: model.provider, thinking: model.thinking ?? [] }));
      this.cache = { at: Date.now(), models };
      return models;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** omp keeps a directory's conversations in a folder named after it: relative to the home directory with dashes, else the absolute path between double dashes. */
  sessionsDir(cwd: string): string {
    const home = this.options.home ?? homedir();
    const root = this.options.sessionsRoot ?? join(home, ".omp/agent/sessions");
    const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
    const inHome = real.startsWith(`${home}/`);
    return join(root, inHome ? `-${real.slice(home.length + 1).replaceAll("/", "-")}` : `--${real.slice(1).replaceAll("/", "-")}--`);
  }

  private sessions(cwd: string): OmpInfo["sessions"] {
    const dir = this.sessionsDir(cwd);
    let files: { path: string; mtime: number }[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }));
    } catch {
      return [];
    }
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS).flatMap(({ path, mtime }) => {
      const head = Buffer.alloc(HEAD_BYTES);
      const fd = openSync(path, "r");
      let read: number;
      try { read = readSync(fd, head, 0, HEAD_BYTES, 0); } finally { closeSync(fd); }
      let title = "";
      let id: string | null = null;
      for (const line of head.toString("utf8", 0, read).split("\n").slice(0, 6)) {
        try {
          const entry = JSON.parse(line) as { type?: string; title?: unknown; id?: unknown };
          if (entry.type === "title" && typeof entry.title === "string") title = entry.title.replace(/^title>/, "").slice(0, 160);
          if (entry.type === "session" && typeof entry.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(entry.id)) id = entry.id;
        } catch { /* a partial line at the end of the head */ }
      }
      return id === null ? [] : [{ id, title: title || "제목 없음", updatedAt: Math.round(mtime) }];
    });
  }

  async info(cwd: string): Promise<OmpInfo> {
    if (!isAbsolute(cwd)) throw invalid("cwd must be an absolute path");
    try {
      return { models: await this.models(), sessions: this.sessions(cwd) };
    } catch (error) {
      throw new CommandError("unavailable", error instanceof Error ? error.message : "could not read omp");
    }
  }
}
