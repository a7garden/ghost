/**
 * 근무 상태(출근 · 퇴근) — 2026.11.10 소유자 요청.
 *
 * 퇴근 중에는 어떤 Ghost 도 스스로 새 일을 시작하지 않는다. 퇴근한 사이에 자율 깨우기 · 예약 · 활동 규칙이 돌아
 * 토큰이 쓰이는 일을 막으려는 것이다. 이미 진행 중인 일(맡긴 일의 대화 · 위임 · 검토 · 재시작 뒤 한 번 깨우기)은 마저 끝낸다.
 * 소유자가 직접 보낸 메시지 · 직접 만든 일은 막지 않는다 — 소유자가 그 자리에 있다는 뜻이기 때문이다.
 *
 * 퇴근 중에 때가 된 예약 · 자율 깨우기 · 활동 규칙은 버리지 않고 기다렸다가 출근하면 한 번씩 돈다.
 *
 * 상태는 원장 settings 의 `duty` 키 하나에 둔다(새 테이블 · migration 없이). 시각은 Host PC 의 현지 시각이다.
 */
import type { Duty, DutyHours, DutyOverride } from "@ghost/contract";
import type { Core } from "./core.ts";

const KEY = "duty";
const DAY = 24 * 60 * 60 * 1000;

interface Stored {
  hours: DutyHours | null;
  override: DutyOverride | null;
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** `at` 이 들어 있는 날의 자정에서 `minutes` 분 뒤. 서머타임이 있어도 현지 시계 기준이다. */
function atClock(at: number, dayOffset: number, minutes: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  date.setMinutes(minutes);
  return date.getTime();
}

/** 시간표대로라면 `at` 에 근무 중인가. 자정을 넘는 근무는 시작한 날의 요일을 따른다. */
export function inHours(hours: DutyHours, at: number): boolean {
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start === end) return hours.days.includes(new Date(at).getDay()); // 하루 종일
  for (const offset of [0, -1]) {
    const from = atClock(at, offset, start);
    const to = end > start ? atClock(at, offset, end) : atClock(at, offset + 1, end);
    if (at >= from && at < to && hours.days.includes(new Date(from).getDay())) return true;
  }
  return false;
}

/** `at` 뒤로 시간표가 처음 상태를 바꾸는 시각. 8일 안에 없으면 null(요일이 7일 모두이고 하루 종일인 경우). */
export function nextBoundary(hours: DutyHours, at: number): number | null {
  const now = inHours(hours, at);
  const candidates: number[] = [];
  for (let offset = -1; offset <= 8; offset++) {
    candidates.push(atClock(at, offset, minutesOf(hours.start)), atClock(at, offset, minutesOf(hours.end)));
  }
  candidates.sort((a, b) => a - b);
  return candidates.find((candidate) => candidate > at && inHours(hours, candidate) !== now) ?? null;
}

export class DutyClock {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastOnDuty: boolean | null = null;
  /** 근무 상태가 바뀌면 부른다 — 예약 타이머를 다시 맞추고 자율 깨우기를 한 번 돌린다. */
  private readonly listeners = new Set<(onDuty: boolean) => void>();

  constructor(private readonly core: Core) {}

  private load(): Stored {
    return this.core.ledger.setting<Stored>(KEY, { hours: null, override: null });
  }

  view(now = Date.now()): Duty {
    const stored = this.load();
    const override = stored.override && (stored.override.until === null || now < stored.override.until) ? stored.override : null;
    const scheduled = stored.hours ? inHours(stored.hours, now) : true;
    const boundary = stored.hours ? nextBoundary(stored.hours, now) : null;
    return {
      onDuty: override ? override.onDuty : scheduled,
      hours: stored.hours,
      override,
      nextChangeAt: override ? override.until : boundary,
    };
  }

  /** 지금 Ghost 가 스스로 새 일을 시작해도 되는가. */
  onDuty(now = Date.now()): boolean {
    return this.view(now).onDuty;
  }

  /** 원버튼. 시간표와 같은 상태로 돌리면 전환을 지우고, 다르면 다음 시간표 경계까지만 유지한다. */
  switch(onDuty: boolean, now = Date.now()): Duty {
    const stored = this.load();
    const scheduled = stored.hours ? inHours(stored.hours, now) : true;
    const override: DutyOverride | null = onDuty === scheduled ? null : { onDuty, until: stored.hours ? nextBoundary(stored.hours, now) : null };
    return this.save({ ...stored, override }, now);
  }

  /** 시간표를 바꾸면 손으로 바꾼 상태는 지운다 — 새 시간표가 곧 소유자의 뜻이다. */
  setHours(hours: DutyHours | null, now = Date.now()): Duty {
    return this.save({ hours, override: null }, now);
  }

  private save(stored: Stored, now: number): Duty {
    const view = this.core.ledger.tx(() => {
      this.core.ledger.putSetting(KEY, stored);
      const view = this.view(now);
      this.core.ledger.emit({ type: "duty", duty: view });
      return view;
    });
    this.changed(view.onDuty);
    this.arm();
    return view;
  }

  onChange(listener: (onDuty: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(onDuty: boolean) {
    if (this.lastOnDuty === onDuty) return;
    this.lastOnDuty = onDuty;
    for (const listener of this.listeners) {
      try {
        listener(onDuty);
      } catch (error) {
        this.core.log("duty listener failed", error);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastOnDuty = this.onDuty();
    this.arm();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }

  /** 다음 경계에 깨어나 화면에 알리고 기다리던 일을 깨운다. 타이머 상한은 하루 — 시계가 바뀌어도 하루 안에 바로잡는다. */
  private arm() {
    if (!this.running) return;
    clearTimeout(this.timer ?? undefined);
    const next = this.view().nextChangeAt;
    const delay = next === null ? DAY : Math.max(1000, Math.min(DAY, next - Date.now() + 500));
    this.timer = setTimeout(() => {
      const view = this.view();
      if (view.onDuty !== this.lastOnDuty) {
        this.core.ledger.tx(() => this.core.ledger.emit({ type: "duty", duty: view }));
        this.changed(view.onDuty);
      }
      this.arm();
    }, delay);
  }
}
