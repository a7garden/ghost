import { Type, type Static } from "typebox";
import { Timestamp, nullable } from "./entities.ts";

/**
 * 근무 상태 (2026.11.10). 퇴근하면 모든 Ghost 가 스스로 새 일을 시작하지 않는다.
 * 막는 것: 자율 깨우기 · 예약 · 활동 규칙(시간표 · 출처 감시 · 다음 확인) · Ghost 가 스스로 시작하는 새 일.
 * 막지 않는 것: 이미 진행 중인 일(위임 · 검토 포함)과 소유자가 직접 시키는 일.
 */

/** "HH:MM", 24시간제, Host PC 의 현지 시각. */
const Clock = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" });

/** 근무 시간표. `start` 가 `end` 보다 늦으면 자정을 넘는 근무다. `days` 는 근무가 시작하는 요일(0=일 … 6=토). */
export const DutyHours = Type.Object({
  start: Clock,
  end: Clock,
  days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
});
export type DutyHours = Static<typeof DutyHours>;

/** 원버튼으로 바꾼 상태. 시간표가 있으면 다음 시간표 경계(`until`)까지, 없으면 다시 바꿀 때까지. */
export const DutyOverride = Type.Object({
  onDuty: Type.Boolean(),
  until: nullable(Timestamp),
});
export type DutyOverride = Static<typeof DutyOverride>;

export const Duty = Type.Object({
  /** 지금 근무 중인가. */
  onDuty: Type.Boolean(),
  hours: nullable(DutyHours),
  override: nullable(DutyOverride),
  /** 다음에 근무 상태가 저절로 바뀌는 시각. 시간표도 기한 있는 전환도 없으면 null. */
  nextChangeAt: nullable(Timestamp),
});
export type Duty = Static<typeof Duty>;
