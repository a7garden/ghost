import { expect, test } from "bun:test";
import type { DutyHours } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { inHours, nextBoundary } from "../src/core/duty.ts";
import { snapshot } from "../src/core/state.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { harness } from "./support.ts";

const MINUTE = 60_000;
/** 2030-01-14 은 월요일이다. 현지 시각으로 만든다. */
const at = (day: number, hours: number, minutes = 0) => new Date(2030, 0, 14 + day, hours, minutes).getTime();
const office: DutyHours = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const night: DutyHours = { start: "22:00", end: "06:00", days: [1, 2, 3, 4, 5] };
const owner = new Access({ kind: "owner" });

test("office hours: weekdays 09:00–18:00, closed on weekends", () => {
  expect(inHours(office, at(0, 8, 59))).toBe(false);
  expect(inHours(office, at(0, 9))).toBe(true);
  expect(inHours(office, at(0, 17, 59))).toBe(true);
  expect(inHours(office, at(0, 18))).toBe(false);
  expect(inHours(office, at(5, 10))).toBe(false); // 토요일
  expect(nextBoundary(office, at(0, 12))).toBe(at(0, 18));
  expect(nextBoundary(office, at(4, 19))).toBe(at(7, 9)); // 금요일 저녁 → 다음 월요일 아침
});

test("a shift past midnight follows the day it started", () => {
  expect(inHours(night, at(0, 23))).toBe(true); // 월요일 밤
  expect(inHours(night, at(1, 5))).toBe(true); // 화요일 새벽은 월요일 근무
  expect(inHours(night, at(6, 3))).toBe(false); // 일요일 새벽은 토요일 근무라 쉰다
  expect(nextBoundary(night, at(0, 23))).toBe(at(1, 6));
});

test("without hours the one button holds until it is pressed again", () => {
  const { core } = harness();
  expect(core.duty.view().onDuty).toBe(true);
  const off = core.duty.switch(false);
  expect(off).toMatchObject({ onDuty: false, override: { onDuty: false, until: null }, nextChangeAt: null });
  const on = core.duty.switch(true);
  expect(on).toMatchObject({ onDuty: true, override: null });
});

test("with hours the one button holds only until the next boundary", () => {
  const { core } = harness();
  core.duty.setHours(office, at(0, 10));
  expect(core.duty.view(at(0, 10)).onDuty).toBe(true);
  // 일찍 퇴근: 18:00 까지 퇴근으로 두고, 그 뒤는 시간표대로(어차피 퇴근), 다음 날 9시에 출근.
  core.duty.switch(false, at(0, 15));
  expect(core.duty.view(at(0, 15))).toMatchObject({ onDuty: false, nextChangeAt: at(0, 18) });
  expect(core.duty.onDuty(at(0, 20))).toBe(false);
  expect(core.duty.onDuty(at(1, 9))).toBe(true);
  // 야근: 시간표가 퇴근인 저녁에 출근하면 다음 날 아침 경계까지 근무.
  core.duty.switch(true, at(1, 20));
  expect(core.duty.onDuty(at(1, 23))).toBe(true);
  expect(core.duty.view(at(1, 20)).nextChangeAt).toBe(at(2, 9));
  // 시간표와 같은 상태로 누르면 전환이 지워진다.
  expect(core.duty.switch(false, at(1, 21)).override).toBeNull();
});

test("off duty, due schedules and self-directed wakes wait; back on duty they run once", async () => {
  const { core, engine, ledger } = harness();
  const ghost = core.createGhost({ name: "Mate", persona: "Research", isDefault: true });
  const direct = ghost.directConversationId;
  const now = Date.now() + 2 * MINUTE;
  core.schedules.create({ ghostId: ghost.id, prompt: "Morning report", spec: { kind: "at", at: now - MINUTE } });
  core.duty.switch(false);
  await core.schedules.tick(now);
  await core.autonomy.tick(now);
  await core.autonomy.tick(now + 3 * 60 * MINUTE);
  await core.idle();
  expect(engine.to(direct)).toEqual([]);
  expect(ledger.dueSchedules(now)).toHaveLength(1);

  core.duty.switch(true);
  await core.schedules.tick(now);
  await core.idle();
  expect(engine.to(direct).map((submission) => submission.text)).toEqual([expect.stringContaining("Morning report")]);
  expect(ledger.dueSchedules(now)).toHaveLength(0);
  core.stop();
});

test("the switch is an owner command that reaches the snapshot and the event stream", async () => {
  const { core, ledger } = harness();
  core.createGhost({ name: "Main", persona: "", isDefault: true });
  const events: string[] = [];
  ledger.subscribe((event) => events.push(event.data.type));
  const context = { publicOrigin: "http://localhost", documents: null };
  await execute(core, owner, { requestId: crypto.randomUUID(), command: { type: "duty.hours", hours: office } }, context);
  await execute(core, owner, { requestId: crypto.randomUUID(), command: { type: "duty.switch", onDuty: false } }, context);
  expect(events.filter((type) => type === "duty")).toHaveLength(2);
  const duty = snapshot(core, owner).duty!;
  expect(duty.onDuty).toBe(false);
  expect(duty.hours).toEqual(office);
  core.stop();
});

test("off duty, a Ghost cannot start new Work on its own, but owner-requested Work still starts", async () => {
  const { core, ledger } = harness();
  const ghost = core.createGhost({ name: "Main", persona: "", isDefault: true });
  const tools = createToolSet({ core, sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} }, memory: null, documents: null, skills: null });
  const conversation = ledger.conversation(ghost.directConversationId);
  const workCreate = tools.extensionsFor(conversation, ledger.ghost(ghost.id), null).flatMap((extension) => extension.tools ?? []).find((tool) => tool.name === "work_create")!;
  // 도구는 Pi 대화 id 로 Ghost 대화를 찾는다.
  ledger.setPiConversationId(conversation.id, "pi-direct");
  const api = (callId: string) => ({ conversationId: "pi-direct", callId, env: undefined, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;
  const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" } as never;
  core.duty.switch(false);
  const refused = await workCreate.execute({ title: "Self-started", brief: "B", initiative: true } as never, api("c1"), context);
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("off duty");
  const asked = await workCreate.execute({ title: "Owner asked", brief: "B" } as never, api("c2"), context);
  expect(asked.isError).toBeFalsy();
  expect(ledger.worksForState().map((work) => work.title)).toEqual(["Owner asked"]);
  core.stop();
});
