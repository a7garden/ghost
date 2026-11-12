import { expect, test } from "bun:test";
import { CLOCK_MARKER, clockStamp, withClockStamp, withoutClockStamp } from "../src/core/clock.ts";

test("the clock stamp names UTC and the owner's timezone for one moment", () => {
  const stamp = clockStamp(Date.UTC(2026, 10, 12, 15, 30, 0));
  expect(stamp).toBe(`${CLOCK_MARKER} 2026-11-12T15:30:00.000Z · 2026-11-13 00:30:00 Asia/Seoul`);
});

test("the transcript drops only the Host's trailing stamp", () => {
  const at = Date.UTC(2026, 10, 12, 0, 30, 0);
  expect(withoutClockStamp(withClockStamp("지금 몇 시야", at))).toBe("지금 몇 시야");
  // Owner text that merely quotes the marker mid-message stays whole.
  const quoted = `시계 줄은 이렇게 생겼어\n\n${CLOCK_MARKER} 예시\n끝`;
  expect(withoutClockStamp(quoted)).toBe(quoted);
});
