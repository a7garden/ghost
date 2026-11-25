import type { Core } from "../core/core.ts";
import { CommandError } from "../core/errors.ts";
import type { MailAccount, MailInboxCursor, MailService } from "./mail.ts";

const POLL_MS = 5 * 60_000;
interface Clock {
  now(): number;
  repeat(tick: () => Promise<void>, intervalMs: number): () => void;
}
const systemClock: Clock = {
  now: Date.now,
  repeat(tick, intervalMs) {
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
  },
};

function preview(value: string, max: number): string {
  const text = value.replace(/\p{White_Space}+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

/** Passive owner notifications; neither a model turn nor a mail mutation. */
export class MailWatcher {
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly backoff = new Map<string, { failures: number; retryAt: number }>();
  private readonly active = new Map<string, Promise<void>>();
  private cancelTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly core: Core, private readonly mail: MailService, options: { clock?: Clock; intervalMs?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.intervalMs = options.intervalMs ?? POLL_MS;
  }

  async start(): Promise<void> {
    if (this.closed) return;
    if (!this.cancelTimer) {
      this.cancelTimer = this.clock.repeat(() => this.poll(), this.intervalMs);
      await this.poll();
    }
  }

  /** Stop scheduling and publishing. Host cleanup closes MailService to abort its transports. */
  async stop(): Promise<void> {
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await Promise.allSettled(this.active.values());
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const accounts = this.mail.accounts();
      for (const id of this.backoff.keys()) {
        if (!accounts.some(account => account.connectionId === id)) this.backoff.delete(id);
      }
      const now = this.clock.now(), scans: Promise<void>[] = [];
      for (const account of accounts) {
        const { connectionId } = account;
        if (this.active.has(connectionId) || (this.backoff.get(connectionId)?.retryAt ?? 0) > now) continue;
        const scan = this.scanAccount(account).finally(() => { this.active.delete(connectionId); });
        this.active.set(connectionId, scan);
        scans.push(scan);
      }
      await Promise.all(scans);
    } catch {
      if (!this.closed) this.core.log("mail watcher scan failed");
    }
  }

  private async scanAccount(account: MailAccount): Promise<void> {
    const { ledger } = this.core;
    const { connectionId } = account;
    const key = `mail-watch:${connectionId}`;
    try {
      const previous = ledger.setting<MailInboxCursor | null>(key, null);
      const { cursor, count, maxUnreadUid, newest } = await this.mail.inboxWindow(connectionId, previous);
      if (this.closed) return;
      const { uidValidity, highWaterUid } = cursor;
      if (previous?.uidValidity === uidValidity && previous.highWaterUid === highWaterUid) {
        this.backoff.delete(connectionId);
        return;
      }

      ledger.tx(() => {
        if (maxUnreadUid !== null) {
          const ghost = ledger.defaultGhost();
          if (!ghost) return;
          // Message rows display the Ghost's name in place of the notification title.
          const name = preview(account.name, 100) || preview(account.address, 100) || "메일 계정";
          const lines = [`${name} · 새 메일 ${count}통`];
          for (const message of newest) {
            const from = preview(message.from?.address ?? "", 60) || "보낸 사람 미상";
            const subject = preview(message.subject, 100) || "제목 없음";
            lines.push(`${from}, ${subject}`);
          }
          this.core.notify({
            id: `mail-new:${connectionId}:${uidValidity}:${maxUnreadUid}`, kind: "message",
            ghostId: ghost.id, conversationId: ghost.directConversationId, workId: null, decisionId: null,
            title: "새 메일", body: lines.join("\n"),
          });
        }
        ledger.putSetting(key, cursor);
      });
      this.backoff.delete(connectionId);
    } catch (error) {
      if (this.closed) return;
      const failures = Math.min((this.backoff.get(connectionId)?.failures ?? 0) + 1, 4);
      this.backoff.set(connectionId, { failures, retryAt: this.clock.now() + this.intervalMs * 2 ** failures });
      this.core.log("mail watcher account scan failed", { connectionId, reason: error instanceof CommandError ? error.message : "internal error" });
    }
  }
}
