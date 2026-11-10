import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStatus } from "@ghost/contract";
import { CommandError } from "../core/errors.ts";
import type { Core } from "../core/core.ts";
import { runReleaseCommand, sha256, validateTarball, verifyReleaseDirectory } from "./archive.ts";
import { GitHubClient, MAX_ASSET_BYTES, newer, parseManifest, type ReleaseManifest, type UpdateFetch } from "./github.ts";
import { buildIdentity, RELEASE_PUBKEY, RELEASE_REPOSITORY } from "./identity.ts";
import { verifyMinisign } from "./signature.ts";
import { atomicWrite, detectLayout, readCredential, readPending, readState, validUpdateResult, type ReleaseLayout, type UpdateLog, type UpdateState } from "./storage.ts";

const HOUR = 60 * 60 * 1000;
const BACKOFF = [5, 10, 20, 40, 60];
export interface UpdaterOptions {
  root: string;
  repository?: string | null;
  pubkey?: string | null;
  identity?: { version: string; commit: string; storage: string };
  execPath?: string;
  fetch?: UpdateFetch;
  idle: () => boolean | Promise<boolean>;
  shutdown?: () => void;
  backup?: (root: string, destination: string) => unknown | Promise<unknown>;
  now?: () => number;
  pollMs?: number;
  env?: Record<string, string | undefined>;
  log?: UpdateLog;
  startupSoakMs?: number;
}

/** The engine mirrors live running state into the ledger's busy flag. */
export function hostIsIdle(core: Core): boolean {
  const conversations = core.ledger.conversations();
  return !core.hasQueuedLanes() && !conversations.some((conversation) => conversation.busy);
}

/** launchd must regain control even when a graceful shutdown cannot finish. */
export function shutdownForUpdate(
  signal: () => void = () => { process.kill(process.pid, "SIGTERM"); },
  exit: (code: number) => void = (code) => { process.exit(code); },
  graceMs = 60_000,
): void {
  const timer = setTimeout(() => exit(75), graceMs);
  timer.unref?.();
  signal();
}

export class Updater {
  private readonly identity;
  private readonly layout: ReleaseLayout | null;
  private readonly client: GitHubClient | null;
  private readonly pubkey: string | null;
  private readonly now: () => number;
  private readonly log: UpdateLog;
  private state: UpdateState;
  private token: string | null;
  private manifest: ReleaseManifest | null = null;
  private phase: UpdateStatus["phase"] = "idle";
  private error: string | null = null;
  private nextCheckAt: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private soakTimer: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;
  private checking: Promise<UpdateStatus> | null = null;
  private checkAbort: AbortController | null = null;
  private installing: Promise<void> | null = null;
  private installAbort: AbortController | null = null;
  private shellDownloading: Promise<string> | null = null;
  private shellAbort: AbortController | null = null;
  private readonly disabledReason: UpdateStatus["disabledReason"];

  constructor(private readonly options: UpdaterOptions) {
    this.identity = options.identity ?? buildIdentity;
    this.pubkey = options.pubkey === undefined ? RELEASE_PUBKEY : options.pubkey;
    const repository = options.repository === undefined ? RELEASE_REPOSITORY : options.repository;
    this.layout = detectLayout(options.execPath);
    const env = options.env ?? process.env;
    this.disabledReason = !repository || !this.pubkey || this.identity.commit === "dev" ? "development" : !this.layout ? "layout" : env.GHOST_SERVICE !== "launchd" ? "service" : null;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message, detail) => console.error(`[ghost] ${message}`, detail ?? ""));
    this.state = readState(options.root, this.log);
    this.token = readCredential(options.root, this.log);
    this.client = repository ? new GitHubClient(repository, () => this.token, options.fetch) : null;
    if (this.layout) {
      const releases = join(this.layout.base, "releases");
      for (const name of readdirSync(releases)) {
        if (name.startsWith(".staging-") || name.startsWith(".download-")) {
          try { rmSync(join(releases, name), { recursive: true, force: true }); }
          catch (error) { this.log("중단된 업데이트 파일을 지우지 못했습니다.", error); }
        }
      }
    }
    if ((this.state.manifest !== undefined || this.state.signature !== undefined) && this.pubkey) {
      try {
        if (!this.state.manifest || !this.state.signature) throw new Error("incomplete cached release");
        const bytes = Buffer.from(this.state.manifest);
        if (!verifyMinisign(this.pubkey, this.state.signature, bytes)) throw new Error("invalid cached release signature");
        this.manifest = parseManifest(bytes);
      } catch (error) { this.log("저장된 업데이트 정보를 읽지 못했습니다.", error); }
    }
    this.schedule();
  }

  status(): UpdateStatus {
    const manifest = this.manifest;
    return {
      enabled: this.disabledReason === null, disabledReason: this.disabledReason, hasCredential: this.token !== null,
      current: { version: this.identity.version, commit: this.identity.commit }, autoCheck: this.state.autoCheck, phase: this.phase,
      latest: manifest && newer(manifest.version, this.identity.version) ? { version: manifest.version, commit: manifest.commit, notes: manifest.notes, publishedAt: manifest.publishedAt } : null,
      shell: manifest ? { version: manifest.shell.version, notes: manifest.shell.notes } : null,
      checkedAt: this.state.checkedAt, nextCheckAt: this.nextCheckAt, error: this.error, lastResult: this.state.lastResult ?? null,
    };
  }

  private persist(): void { atomicWrite(join(this.options.root, "update", "state.json"), `${JSON.stringify(this.state)}\n`); }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.disabledReason || !this.token || !this.state.autoCheck) { this.nextCheckAt = null; return; }
    const interval = this.state.failures ? BACKOFF[Math.min(this.state.failures - 1, BACKOFF.length - 1)]! * 60_000 : HOUR;
    this.nextCheckAt = this.state.checkedAt === null ? this.now() : this.state.checkedAt + interval;
    if (!this.started || this.installing) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.check().catch(() => {}); }, Math.max(0, this.nextCheckAt - this.now()));
    this.timer.unref?.();
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.schedule();
    this.soakTimer = setTimeout(() => { this.soakTimer = undefined; this.confirmStartup(); }, this.options.startupSoakMs ?? 60_000);
    this.soakTimer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.soakTimer);
    this.soakTimer = undefined;
    this.checkAbort?.abort();
    this.installAbort?.abort();
    this.shellAbort?.abort();
    await Promise.allSettled([this.checking, this.installing, this.shellDownloading]);
  }

  settings(input: { autoCheck?: boolean; token?: string | null }): UpdateStatus {
    if (this.installing || this.checking) throw new CommandError("conflict", "업데이트 작업이 진행 중입니다.");
    if (input.autoCheck !== undefined && typeof input.autoCheck !== "boolean") throw new CommandError("invalid", "자동 확인 설정이 올바르지 않습니다.");
    if (input.token !== undefined && input.token !== null && (typeof input.token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(input.token))) throw new CommandError("invalid", "토큰이 올바르지 않습니다.");
    if (input.token !== undefined) {
      const directory = join(this.options.root, "secrets");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const path = join(directory, "update-github.json");
      if (input.token === null) rmSync(path, { force: true });
      else atomicWrite(path, `${JSON.stringify({ token: input.token })}\n`);
      this.token = input.token;
    }
    if (input.autoCheck !== undefined) this.state.autoCheck = input.autoCheck;
    this.persist();
    this.schedule();
    return this.status();
  }

  check(): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    if (this.installing) throw new CommandError("conflict", "업데이트 작업이 진행 중입니다.");
    if (this.disabledReason || !this.token || !this.client || !this.pubkey || this.closed) return Promise.resolve(this.status());
    this.phase = "checking";
    this.error = null;
    const controller = this.checkAbort = new AbortController();
    this.checking = (async () => {
      try {
        const release = await this.client!.release(undefined, controller.signal);
        const verified = await this.client!.manifest(release, this.pubkey!, controller.signal);
        this.manifest = verified.manifest;
        this.state.manifest = verified.bytes;
        this.state.signature = verified.signature;
        this.state.failures = 0;
        this.phase = "idle";
      } catch (error) {
        if (!this.closed) {
          this.state.failures++;
          this.phase = "error";
          this.error = error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "업데이트를 확인하지 못했습니다.";
        }
      } finally {
        this.state.checkedAt = this.now();
        this.persist();
        this.checkAbort = null;
        this.checking = null;
        this.schedule();
      }
      return this.status();
    })();
    return this.checking;
  }

  install(version: string): UpdateStatus {
    if (this.disabledReason || !this.token || !this.client || !this.layout || this.closed) throw new CommandError("unavailable", "업데이트를 사용할 수 없습니다.");
    if (this.installing || !["idle", "error"].includes(this.phase) || this.status().latest?.version !== version) throw new CommandError("conflict", "설치할 업데이트를 다시 확인해 주세요.");
    const manifest = this.manifest!;
    const controller = this.installAbort = new AbortController();
    this.phase = "downloading";
    this.error = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.installing = this.performInstall(manifest, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) { this.phase = "idle"; this.error = null; }
      else { this.phase = "error"; this.error = error instanceof Error && /[가-힣]/.test(error.message) ? error.message : "업데이트를 설치하지 못했습니다."; }
    }).finally(() => { this.installing = null; this.installAbort = null; this.schedule(); });
    return this.status();
  }

  /** Test and shutdown barrier; install() itself intentionally returns before downloading. */
  async settled(): Promise<void> { await this.installing; }

  async cancel(): Promise<UpdateStatus> {
    if (this.phase === "installing") throw new CommandError("conflict", "설치 중에는 취소할 수 없습니다.");
    if (this.phase === "downloading" || this.phase === "waiting") { this.installAbort?.abort(); await this.installing; }
    return this.status();
  }

  private async performInstall(manifest: ReleaseManifest, signal: AbortSignal): Promise<void> {
    const layout = this.layout!;
    const releases = join(layout.base, "releases");
    const name = `${manifest.version}-${manifest.commit}`;
    const staging = join(releases, `.staging-${crypto.randomUUID()}`);
    const archive = join(releases, `.download-${crypto.randomUUID()}.tar.gz`);
    const target = join(releases, name);
    let stagedTarget = false;
    let swapped = false;
    let backupPath: string | null = null;
    try {
      const release = await this.client!.release(`v${manifest.version}`, signal);
      const verified = await this.client!.manifest(release, this.pubkey!, signal);
      if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new Error("릴리스 정보가 변경되었습니다. 다시 확인해 주세요.");
      const bytes = await this.client!.asset(release, manifest.host.asset, manifest.host.bytes, signal);
      signal.throwIfAborted();
      if (bytes.length !== manifest.host.bytes || sha256(bytes) !== manifest.host.sha256) throw new Error("업데이트 파일 검증에 실패했습니다.");
      await validateTarball(bytes);
      mkdirSync(staging, { mode: 0o700 });
      atomicWrite(archive, bytes);
      await runReleaseCommand(["/usr/bin/tar", "-xzf", archive, "-C", staging, "--no-same-owner"], signal);
      verifyReleaseDirectory(staging, manifest);
      const version = JSON.parse(await runReleaseCommand([join(staging, "ghost"), "version"], signal));
      if (version.version !== manifest.version || version.commit !== manifest.commit || version.storage !== manifest.storage) throw new Error("업데이트 실행 버전이 일치하지 않습니다.");
      signal.throwIfAborted();
      if (target === layout.directory) throw new Error("실행 중인 릴리스는 덮어쓸 수 없습니다.");
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      stagedTarget = true;
      this.phase = "waiting";
      let backupFailures = 0;
      while (true) {
        signal.throwIfAborted();
        if (!await this.options.idle()) { await this.wait(signal); continue; }
        signal.throwIfAborted();
        this.phase = "installing";
        backupPath = join(layout.base, "backups", `pre-${name}-${this.now()}`);
        try {
          if (this.options.backup) await this.options.backup(this.options.root, backupPath);
          else await runReleaseCommand([process.execPath, "backup", backupPath, "--root", this.options.root], signal, 120_000);
          backupFailures = 0;
        } catch (error) {
          rmSync(backupPath, { recursive: true, force: true });
          backupPath = null;
          signal.throwIfAborted();
          this.log("백업을 완료하지 못해 업데이트 설치를 기다립니다.", error);
          if (++backupFailures >= 10) throw new Error("백업을 완료하지 못했습니다. 잠시 후 다시 설치해 주세요.");
          this.phase = "waiting";
          await this.wait(signal);
          continue;
        }
        if (!await this.options.idle()) {
          rmSync(backupPath, { recursive: true, force: true });
          backupPath = null;
          this.phase = "waiting";
          await this.wait(signal);
          continue;
        }
        signal.throwIfAborted();
        const currentLayout = detectLayout(this.options.execPath);
        if (!currentLayout || currentLayout.directory !== layout.directory) throw new Error("실행 중인 릴리스 경로가 변경되었습니다.");
        atomicWrite(join(this.options.root, "update", "attempts"), "0\n");
        atomicWrite(join(this.options.root, "update", "pending"), `${layout.name} ${manifest.storage === this.identity.storage ? "yes" : "no"} ${name}\n`);
        const temporary = join(layout.base, `.current-${crypto.randomUUID()}`);
        try {
          symlinkSync(`releases/${name}`, temporary);
          renameSync(temporary, join(layout.base, "current"));
          swapped = true;
          if (readlinkSync(join(layout.base, "current")) !== `releases/${name}`) throw new Error("업데이트 경로 전환을 확인하지 못했습니다.");
        } finally { rmSync(temporary, { force: true }); }
        (this.options.shutdown ?? shutdownForUpdate)();
        return;
      }
    } finally {
      rmSync(archive, { force: true });
      rmSync(staging, { recursive: true, force: true });
      if (!swapped) {
        if (stagedTarget) rmSync(target, { recursive: true, force: true });
        rmSync(join(this.options.root, "update", "pending"), { force: true });
        rmSync(join(this.options.root, "update", "attempts"), { force: true });
      }
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, this.options.pollMs ?? 5000);
    timer.unref?.();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return promise;
  }

  confirmStartup(): void {
    const resultPath = join(this.options.root, "update", "result.json");
    try {
      let pending = null;
      try { pending = readPending(this.options.root); }
      catch (error) { this.log("업데이트 대기 정보를 읽지 못했습니다.", error); }
      let result: UpdateStatus["lastResult"] = null;
      if (existsSync(resultPath)) {
        try {
          const value: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
          if (!validUpdateResult(value)) throw new Error("invalid update result");
          result = value;
        } catch (error) {
          this.log("업데이트 결과를 읽지 못했습니다.", error);
          rmSync(resultPath, { force: true });
        }
      }
      if (!result && pending) result = { outcome: pending.target === this.layout?.name ? "installed" : "failed", from: pending.previous, to: pending.target, at: this.now() };
      if (!result) return;
      this.state.lastResult = result;
      this.persist();
      rmSync(resultPath, { force: true });
      rmSync(join(this.options.root, "update", "pending"), { force: true });
      rmSync(join(this.options.root, "update", "attempts"), { force: true });
    } catch (error) { this.log("업데이트 시작 결과를 확인하지 못했습니다.", error); }
  }

  shellLatest(origin: string): unknown | null {
    const manifest = this.manifest;
    if (!manifest || this.disabledReason || !this.token) return null;
    return { version: manifest.shell.version, notes: manifest.shell.notes, pub_date: manifest.publishedAt, platforms: { "darwin-aarch64": { signature: manifest.shell.signature, url: `${origin}/api/update/shell/Ghost.app.tar.gz` } } };
  }

  shellAsset(): Promise<string> {
    if (this.shellDownloading) return this.shellDownloading;
    if (!this.manifest || !this.client || !this.token || this.disabledReason || this.closed) throw new CommandError("unavailable", "앱 업데이트를 사용할 수 없습니다.");
    const manifest = this.manifest;
    const directory = join(this.options.root, "update", "cache");
    const path = join(directory, `${manifest.version}-${manifest.commit}-Ghost.app.tar.gz`);
    if (existsSync(path)) return Promise.resolve(path);
    const controller = this.shellAbort = new AbortController();
    this.shellDownloading = (async () => {
      const release = await this.client!.release(`v${manifest.version}`, controller.signal);
      const verified = await this.client!.manifest(release, this.pubkey!, controller.signal);
      if (JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new CommandError("conflict", "릴리스 정보가 변경되었습니다. 다시 확인해 주세요.");
      const bytes = await this.client!.asset(release, manifest.shell.asset, MAX_ASSET_BYTES, controller.signal);
      atomicWrite(path, bytes);
      return path;
    })().finally(() => { this.shellDownloading = null; this.shellAbort = null; });
    return this.shellDownloading;
  }
}
