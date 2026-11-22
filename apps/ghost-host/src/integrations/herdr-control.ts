import { Type } from "typebox";
import { validate, type HerdrControlCommand, type HerdrControlEnd, type HerdrControlLease, type HerdrFrame } from "@ghost/contract";
import { CommandError, conflict } from "../core/errors.ts";
import { type HerdrState, type LeaseRecord, type TerminalSize } from "./herdr-state.ts";

const Frame = Type.Object({ type: Type.Literal("terminal.frame"), bytes: Type.String(), full: Type.Boolean(), seq: Type.Integer(), width: Type.Integer(), height: Type.Integer() });
const Closed = Type.Object({ type: Type.Literal("terminal.closed"), reason: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
const HELD = /already has an attached client; retry with --takeover/;
const TAKEN = /terminal attach taken over/;
const GONE = /terminal .* not found|(?:terminal|pane) (?:was )?closed/;
const MAX_LINE = 16 * 1024 * 1024;
const GRACE = 10_000;
const RESTORE_BACKOFF = [0, 1_000, 2_000, 4_000, 8_000];
const READY_MS = 2_000;
const sameSize = (a: TerminalSize | null | undefined, b: TerminalSize | null | undefined) => a?.cols === b?.cols && a?.rows === b?.rows;

type EndReason = HerdrControlEnd["reason"];
type FrameListener = (frame: HerdrFrame) => void;
export type HerdrControlStream = {
  lease: HerdrControlLease;
  listen(frame: FrameListener, end: (event: HerdrControlEnd) => void): void;
  disconnect(): void;
};
export type HerdrControlRequest = TerminalSize & { pane: string; fit: boolean; takeover: boolean; client: string | null };
export type ControlPane = { terminal: string; viewportRows: number | null; offset: number | null; layout: TerminalSize | null };
type ControlChild = Bun.Subprocess<"pipe", "pipe", "pipe">;
type Wire = ({ type: "terminal.input"; text: string } | ({ type: "terminal.resize" } & TerminalSize) |
  { type: "terminal.scroll"; direction: "up" | "down"; lines: number; source?: "wheel" | "page_key"; column?: number; row?: number } |
  { type: "terminal.mouse"; action: "down" | "up" | "drag" | "move"; button?: "left" | "right" | "middle"; column: number; row: number; modifiers?: number } |
  { type: "terminal.release" });

/** Coalesce without losing the complete repaint that a new viewer needs. */
export function mergeHerdrFrames(pending: HerdrFrame | null, next: HerdrFrame): HerdrFrame {
  if (pending === null || next.full || pending.width !== next.width || pending.height !== next.height) return next;
  return { ...next, full: pending.full, bytes: Buffer.concat([Buffer.from(pending.bytes, "base64"), Buffer.from(next.bytes, "base64")]).toString("base64") };
}

export class HerdrControlRefusal extends Error {
  constructor(readonly code: "held" | "confirm_required", message: string) { super(message); }
}

class Controller {
  readonly first = Promise.withResolvers<void>();
  readonly ended = Promise.withResolvers<string>();
  frameSize: TerminalSize | null = null;
  reason: string | null = null;
  private pending: HerdrFrame | null = null;
  private listener: FrameListener | null = null;

  constructor(private readonly child: ControlChild) {
    void this.first.promise.catch(() => {});
    void new Response(child.stderr).text().catch(() => "");
    void this.read();
  }

  private async read() {
    const decoder = new TextDecoder();
    let rest = "";
    let reason = "";
    try {
      for await (const chunk of this.child.stdout) {
        rest += decoder.decode(chunk, { stream: true });
        let line: number;
        while ((line = rest.indexOf("\n")) >= 0) {
          let data: unknown;
          try { data = JSON.parse(rest.slice(0, line)); } catch { /* An unrelated status line is not a frame. */ }
          rest = rest.slice(line + 1);
          if (validate(Closed, data)) { reason = data.reason ?? "closed"; return; }
          if (!validate(Frame, data)) continue;
          const frame: HerdrFrame = { seq: data.seq, full: data.full, width: data.width, height: data.height, bytes: data.bytes };
          this.frameSize = { cols: frame.width, rows: frame.height };
          this.first.resolve();
          if (this.listener) this.listener(frame);
          else if (frame.full || (this.pending?.bytes.length ?? 0) < MAX_LINE) this.pending = mergeHerdrFrames(this.pending, frame);
        }
        if (rest.length > MAX_LINE) throw Error("herdr frame too large");
      }
      reason = (await this.child.exited) === 0 ? "closed" : "error";
    } catch { reason = "error"; }
    finally {
      this.reason = reason;
      const code = HELD.test(reason) ? "held" : GONE.test(reason) ? "not_found" : "unavailable";
      const error = code === "held" ? new HerdrControlRefusal(code, "다른 곳에서 조작 중입니다.") :
        new CommandError(code, "터미널에 연결하지 못했습니다.");
      this.first.reject(error);
      this.ended.resolve(reason);
    }
  }

  async ready(timeout: number) {
    const expiry = Promise.withResolvers<never>();
    const timer = setTimeout(() => expiry.reject(new CommandError("unavailable", "터미널 연결 시간이 초과됐습니다.")), timeout);
    try {
      await Promise.race([this.first.promise, expiry.promise]);
      if (this.reason !== null) throw new CommandError("unavailable", "터미널 연결이 종료됐습니다.");
    } finally { clearTimeout(timer); }
  }

  listen(listener: FrameListener | null) {
    this.listener = listener;
    if (listener && this.pending) listener(this.pending);
    this.pending = null;
  }

  write(command: Wire) {
    if (this.reason !== null) throw conflict("터미널 연결이 종료됐습니다.");
    try {
      if (this.child.stdin.write(`${JSON.stringify(command)}\n`) <= 0) throw Error("closed stdin");
      this.child.stdin.flush();
    } catch { throw conflict("터미널 연결이 종료됐습니다."); }
  }

  async close(release: boolean) {
    this.listen(null);
    if (release && this.reason === null) {
      try { this.write({ type: "terminal.release" }); } catch { /* The other controller may have taken over. */ }
    }
    try { this.child.stdin.end(); } catch { /* Already closed. */ }
    if (release && this.reason === null) await Promise.race([this.ended.promise, Bun.sleep(200)]);
    this.child.kill();
    await this.child.exited;
  }
}

type Active = {
  client: string;
  principal: string;
  id: string;
  connection: Controller;
  record: LeaseRecord;
  timer?: ReturnType<typeof setTimeout>;
  onEnd?: (event: HerdrControlEnd) => void;
  final?: EndReason;
};

type Options = {
  state: HerdrState;
  inspect(session: string, pane: string, layout: boolean): Promise<ControlPane | null>;
  spawn(session: string, terminal: string, size: TerminalSize, takeover: boolean): ControlChild;
  log?: (message: string, error?: unknown) => void;
  // Time seams keep recovery tests deterministic without changing the production limits.
  grace?: number;
  sleep?: (ms: number) => Promise<unknown>;
};

export class ControlLeases {
  private readonly active = new Map<string, Active>();
  private readonly clients = new Map<string, string>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private startup: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly options: Options) {}

  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.lanes.set(key, next);
    return next.finally(() => { if (this.lanes.get(key) === next) this.lanes.delete(key); });
  }

  recover(): Promise<void> {
    this.startup ??= Promise.all([...this.options.state.leases].map(([key, record]) => this.serial(key, async () => {
      if (await this.restore(key, record)) this.options.state.setLease(key, null);
    }).catch((error) => this.options.log?.(`herdr ${key}: 복구 실패`, error)))).then(() => {});
    return this.startup;
  }

  /** On 0.9.5 the layout still reports the desktop geometry under a control lease; pane.get supplies live height, not width. */
  private refresh(record: LeaseRecord, current: ControlPane, frame: TerminalSize | null): LeaseRecord {
    let baseline = record.baseline;
    const layout = current.layout ?? record.layout;
    if (baseline !== null) {
      // A local change becomes the new restore point per dimension. A queued resize can still report the previous lease size.
      const localRows = current.viewportRows !== null && current.viewportRows !== record.size?.rows &&
        current.viewportRows !== record.priorSize?.rows && frame !== null && sameSize(frame, record.size);
      baseline = {
        cols: record.layout && current.layout && current.layout.cols !== record.layout.cols ? current.layout.cols : baseline.cols,
        rows: record.layout && current.layout && current.layout.rows !== record.layout.rows ? current.layout.rows :
          localRows ? current.viewportRows! : baseline.rows,
      };
    }
    return { ...record, baseline, ...(layout !== undefined ? { layout } : {}) };
  }

  async open(session: string, request: HerdrControlRequest, principal: string, signal: AbortSignal): Promise<HerdrControlStream> {
    const { pane, fit, takeover } = request;
    const key = `${session}/${pane}`;
    const client = `${principal}/${request.client ?? crypto.randomUUID()}`;
    const size: TerminalSize = { cols: request.cols, rows: request.rows };
    return this.serial(`client:${client}`, async () => {
      if (this.stopping || signal.aborted) throw conflict("터미널 연결이 취소됐습니다.");
      // Refusing confirmation must not change the current lease (even one on another pane).
      const first = await this.options.inspect(session, pane, false);
      if (first === null) throw new CommandError("not_found", "터미널이 닫혔습니다.");
      if (!fit && !this.options.state.owns(session, first.terminal)) throw new HerdrControlRefusal("confirm_required", "터미널 크기를 바꿀까요?");
      const other = this.clients.get(client);
      if (other && other !== key) await this.serial(other, async () => {
        const previous = this.active.get(other);
        if (previous?.client === client && !await this.finish(other, previous, "released", true)) throw conflict("이전 터미널 크기를 복구하지 못했습니다.");
      });
      return this.serial(key, async () => {
        if (this.stopping || signal.aborted) throw conflict("터미널 연결이 취소됐습니다.");
        const current = await this.options.inspect(session, pane, true);
        if (current?.terminal !== first.terminal) throw new CommandError("not_found", "터미널이 바뀌었습니다.");
        const owned = this.options.state.owns(session, current.terminal);
        if (!fit && !owned) throw new HerdrControlRefusal("confirm_required", "터미널 크기를 바꿀까요?");
        let previous = this.active.get(key);
        if (previous && previous.record.terminal_id !== current.terminal) {
          await this.finish(key, previous, "closed", false);
          previous = undefined;
        }
        if (previous && previous.client !== client && !takeover) throw new HerdrControlRefusal("held", "다른 곳에서 조작 중입니다.");
        // A failed recovery can leave a valid baseline. A user-confirmed acquisition inherits it without
        // a second attach/resize; herdr can still refuse an outside holder, preserving the older record.
        const saved = previous?.record ?? this.options.state.leases.get(key);
        const persisted = saved?.terminal_id === current.terminal ? saved : undefined;
        if (signal.aborted) throw conflict("터미널 연결이 취소됐습니다.");
        const record: LeaseRecord = persisted ? {
          ...this.refresh(persisted, current, previous?.connection.frameSize ?? null), size, priorSize: persisted.size ?? null,
        } : {
          session, pane, terminal_id: current.terminal, startedAt: Date.now(), size, layout: current.layout,
          baseline: current.layout && current.viewportRows ? { cols: current.layout.cols, rows: current.viewportRows } : null,
        };
        if (previous?.client === client && !takeover) {
          // Replace only our own controller. An unconditional takeover during reconnect could steal a
          // newly attached external client between its takeover and our terminal.closed notification.
          await this.finish(key, previous, "taken", false, true, true);
          previous = undefined;
        }
        this.options.state.setLease(key, record); // Intent is durable before the child can resize the pane.
        let connection: Controller | undefined;
        try {
          connection = new Controller(this.options.spawn(session, current.terminal, size, takeover));
          await connection.ready(READY_MS);
        } catch (error) {
          await connection?.close(false);
          if (previous && previous.connection.reason === null) this.options.state.setLease(key, previous.record);
          else if (error instanceof HerdrControlRefusal) this.options.state.setLease(key, persisted ?? null);
          else if (error instanceof CommandError && error.code === "not_found") this.options.state.setLease(key, null);
          // An uncertain spawn may have resized. Leave its durable record for bounded recovery.
          else if (await this.restore(key, record, true)) this.options.state.setLease(key, null);
          throw error;
        }
        if (previous) await this.finish(key, previous, "taken", false, true);
        const lease: Active = { client, principal, id: crypto.randomUUID(), record, connection };
        this.active.set(key, lease);
        this.clients.set(client, key);
        void connection.ended.promise.then((reason) => this.serial(key, async () => {
          if (this.active.get(key) !== lease) return;
          if (TAKEN.test(reason)) await this.finish(key, lease, "taken", false);
          else if (GONE.test(reason)) await this.finish(key, lease, "closed", false);
          else await this.finish(key, lease, reason === "closed" ? "closed" : "error", true);
        })).catch((error) => this.options.log?.(`herdr ${key}: 연결 종료 처리 실패`, error));
        const disconnect = () => {
          if (this.active.get(key) !== lease || lease.timer !== undefined) return;
          connection.listen(null);
          delete lease.onEnd;
          lease.timer = setTimeout(() => {
            void this.serial(key, async () => {
              if (this.active.get(key) === lease) await this.finish(key, lease, "released", true);
            }).catch((error) => this.options.log?.(`herdr ${key}: 연결 복구 실패`, error));
          }, this.options.grace ?? GRACE);
          lease.timer.unref();
        };
        // The transport owns abort/cancel after acquisition. Handle a disconnect during the handshake here.
        if (signal.aborted) disconnect();
        return {
          lease: { pane, leaseId: lease.id, baseline: record.baseline, owned },
          listen: (frame, end) => {
            if (lease.final) { end({ reason: lease.final }); return; }
            if (lease.timer !== undefined) return;
            lease.onEnd = end;
            connection.listen(frame);
          },
          disconnect,
        };
      });
    });
  }

  async send(session: string, principal: string, command: HerdrControlCommand): Promise<void> {
    const key = `${session}/${command.pane}`;
    await this.serial(key, async () => {
      const active = this.active.get(key);
      if (!active || active.id !== command.leaseId || active.principal !== principal || this.stopping || active.timer !== undefined) throw conflict("조작 연결이 없습니다.");
      const { connection } = active;
      switch (command.type) {
        case "input": connection.write({ type: "terminal.input", text: command.text }); break;
        case "resize": {
          const size = { cols: command.cols, rows: command.rows };
          if (sameSize(active.record.size, size)) break;
          const current = await this.options.inspect(session, command.pane, true);
          if (current?.terminal !== active.record.terminal_id) throw conflict("터미널이 바뀌었습니다.");
          const record = { ...this.refresh(active.record, current, connection.frameSize), size, priorSize: active.record.size ?? null };
          this.options.state.setLease(key, record);
          active.record = record;
          connection.write({ type: "terminal.resize", ...size });
          break;
        }
        case "scroll": {
          const { direction, lines, source, column, row } = command;
          connection.write({ type: "terminal.scroll", direction, lines, ...(source !== undefined ? { source } : {}), ...(column !== undefined ? { column } : {}), ...(row !== undefined ? { row } : {}) });
          break;
        }
        case "mouse": {
          const { action, button, column, row, modifiers } = command;
          connection.write({ type: "terminal.mouse", action, column, row, ...(button !== undefined ? { button } : {}), ...(modifiers !== undefined ? { modifiers } : {}) });
          break;
        }
      }
    });
  }

  async release(session: string, pane: string, id: string, principal: string): Promise<void> {
    const key = `${session}/${pane}`;
    await this.serial(key, async () => {
      const active = this.active.get(key);
      if (active?.id === id && active.principal === principal && !await this.finish(key, active, "released", true)) {
        throw new CommandError("unavailable", "터미널 크기를 복구하지 못했습니다.");
      }
    });
  }

  private async finish(key: string, active: Active, reason: EndReason, restore: boolean, keepRecord = false, detach = restore): Promise<boolean> {
    clearTimeout(active.timer);
    this.active.delete(key);
    if (this.clients.get(active.client) === key) this.clients.delete(active.client);
    active.connection.listen(null);
    let restored = !restore;
    try {
      if (restore) restored = await this.restore(key, active.record, this.stopping, active.connection);
      if (restored && !keepRecord) this.options.state.setLease(key, null);
      return restored;
    } finally {
      try { await active.connection.close(detach); }
      finally {
        active.final = restored ? reason : "error";
        active.onEnd?.({ reason: active.final });
      }
    }
  }

  private async restore(key: string, record: LeaseRecord, once = false, currentConnection?: Controller): Promise<boolean> {
    let lastError: unknown;
    let desired: TerminalSize | null | undefined;
    const { session, pane, terminal_id: terminal } = record;
    for (const delay of RESTORE_BACKOFF) {
      if (delay) {
        if (once || this.stopping) break;
        await (this.options.sleep ?? Bun.sleep)(delay);
      }
      let temporary: Controller | undefined;
      try {
        // Never take control from a desktop or phone that claimed it after this lease.
        if (currentConnection?.reason && TAKEN.test(currentConnection.reason)) return true;
        const current = await this.options.inspect(session, pane, true);
        if (!current || current.terminal !== terminal) return true;
        if (desired === undefined) {
          record = this.refresh(record, current, currentConnection?.frameSize ?? null);
          desired = record.baseline;
          this.options.state.setLease(key, record);
        }
        let connection = currentConnection?.reason === null ? currentConnection : undefined;
        if (!connection) {
          // Starting `control` itself resizes. A null baseline forbids guessing a size for cleanup.
          if (!desired) return true;
          connection = temporary = new Controller(this.options.spawn(session, terminal, desired, false));
          await connection.ready(READY_MS);
        } else if (desired) connection.write({ type: "terminal.resize", ...desired });
        // Wheel can be routed into an app with mouse tracking. Only send it when herdr has actual scrollback to clear.
        if (current.offset !== null && current.offset > 0) connection.write({ type: "terminal.scroll", direction: "down", lines: 65_535, source: "wheel" });
        for (let check = 0; check < 2; check++) {
          await (this.options.sleep ?? Bun.sleep)(50);
          const checked = await this.options.inspect(session, pane, false);
          if (!checked || checked.terminal !== terminal) return true;
          if (connection.reason && TAKEN.test(connection.reason)) return true;
          if (checked.offset === 0 && (!desired || (checked.viewportRows === desired.rows && sameSize(connection.frameSize, desired)))) return true;
        }
        lastError = Error("herdr did not confirm size and scrollback restoration");
      } catch (error) {
        lastError = error;
        if (error instanceof HerdrControlRefusal && error.code === "held") break;
      }
      finally { await temporary?.close(true); }
    }
    this.options.log?.(`herdr ${key}: 터미널 크기 복구 실패`, lastError);
    return false; // Leave the recovery record intact for the next Host start.
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.lanes.values()]);
    await Promise.allSettled([...this.active].map(([key, active]) => this.serial(key, async () => {
      if (this.active.get(key) === active) await this.finish(key, active, "released", true);
    })));
  }
}
