import type { Schedule, ScheduleSpec } from "@ghost/contract";
import type { Core } from "./core.ts";
import { CommandError, conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";

/** Upper bound between ticks, so deadlines are enforced even without schedules. */
const MAX_TICK_MS = 30_000;

export function firstRun(spec: ScheduleSpec, now: number): number {
  if (spec.kind === "at") return spec.at;
  if (spec.startAt >= now) return spec.startAt;
  const periods = Math.ceil((now - spec.startAt) / (spec.seconds * 1000));
  return spec.startAt + periods * spec.seconds * 1000;
}

/** Fires schedules as conversation submissions and enforces Work deadlines. */
export class Schedules {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pollingSources = false;

  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  /** A repeated `id` (from `idFor`) returns the schedule it already created. */
  create(input: { ghostId: string; conversationId?: string; prompt: string; spec: ScheduleSpec; id?: string }): Schedule {
    const existing = input.id ? this.ledger.findSchedule(input.id) : null;
    if (existing) return existing;
    const ghost = this.ledger.ghost(input.ghostId);
    const conversationId = input.conversationId ?? ghost.directConversationId;
    const conversation = this.ledger.conversation(conversationId);
    if (conversation.ghostId !== ghost.id || conversation.kind !== "direct") throw invalid("a schedule targets one of the Ghost's direct conversations");
    const now = Date.now();
    if (input.spec.kind === "at" && input.spec.at <= now) throw invalid("the time is in the past");
    const schedule: Schedule = {
      id: input.id ?? newId(),
      ghostId: ghost.id,
      conversationId,
      prompt: input.prompt,
      spec: input.spec,
      nextAt: firstRun(input.spec, now),
      state: "active",
      createdAt: now,
    };
    this.ledger.tx(() => this.ledger.putSchedule(schedule));
    this.arm();
    return schedule;
  }

  update(scheduleId: string, change: { prompt?: string; spec?: ScheduleSpec; paused?: boolean }): Schedule {
    const schedule = this.ledger.schedule(scheduleId);
    if (schedule.state === "done") throw conflict("the schedule already finished");
    const spec = change.spec ?? schedule.spec;
    const paused = change.paused ?? schedule.state === "paused";
    const next: Schedule = {
      ...schedule,
      prompt: change.prompt ?? schedule.prompt,
      spec,
      state: paused ? "paused" : "active",
      nextAt: paused ? schedule.nextAt : firstRun(spec, Date.now()),
    };
    this.ledger.tx(() => this.ledger.putSchedule(next));
    this.arm();
    return next;
  }

  delete(scheduleId: string) {
    this.ledger.schedule(scheduleId);
    this.ledger.tx(() => this.ledger.deleteSchedule(scheduleId));
  }

  start() {
    this.running = true;
    this.arm();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }

  /** Re-arm after owner rule edits without starting a stopped scheduler. */
  refresh() { this.arm(); }

  private arm() {
    if (!this.running) return;
    clearTimeout(this.timer ?? undefined);
    const scheduleAt = this.ledger.nextScheduleAt();
    // Ignore an in-flight source poll's stale due timestamp, but keep scheduled
    // activities and bounded self-checks authoritative while transport waits.
    const activityAt = this.core.activities.nextDueAt(!this.pollingSources);
    const next = scheduleAt === null ? activityAt : activityAt === null ? scheduleAt : Math.min(scheduleAt, activityAt);
    const delay = next === null ? MAX_TICK_MS : Math.max(1000, Math.min(MAX_TICK_MS, next - Date.now()));
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  /** Fire due schedules once each, expire overdue Work, prune old events. */
  async tick(now = Date.now()) {
    try {
      this.core.works.expire(now);
      for (const schedule of this.ledger.dueSchedules(now)) await this.fire(schedule, now);
      this.ledger.pruneEvents(now);
      await this.core.activities.tickTimers(now);
      this.pollSources(now);
      this.ledger.pruneHistory(now);
      this.ledger.prunePairings(now);
    } catch (error) {
      this.core.log("schedule tick failed", error);
    } finally {
      this.arm();
    }
  }

  private pollSources(now: number) {
    if (this.pollingSources) return;
    this.pollingSources = true;
    // tickSources owns its core lane (including shutdown draining); wrapping it
    // in that same lane would deadlock source polling behind itself.
    void this.core.activities.tickSources(now)
      .catch((error) => this.core.log("activity source tick failed", error))
      .finally(() => {
        this.pollingSources = false;
        this.arm();
      });
  }

  /** Submit first, then advance: a crash in between re-fires with the same request id, which Pi ignores. */
  private async fire(schedule: Schedule, now: number) {
    const at = schedule.nextAt!;
    const ghost = this.ledger.ghost(schedule.ghostId);
    if (ghost.state === "active") {
      try {
        await this.core.engine.submit(schedule.conversationId, {
          text: schedule.prompt,
          origin: "schedule",
          requestId: `schedule:${schedule.id}:${at}`,
        });
      } catch (error) {
        // A refusal (no model, no credential) is an outcome, not a crash: skip this occurrence.
        if (!(error instanceof CommandError)) throw error;
        this.core.log(`schedule ${schedule.id} skipped`, error.message);
      }
    }
    const nextAt = schedule.spec.kind === "every" ? firstRun(schedule.spec, Math.max(now, at) + 1) : null;
    this.ledger.tx(() => this.ledger.putSchedule({ ...schedule, nextAt, state: nextAt === null ? "done" : "active" }));
  }
}
