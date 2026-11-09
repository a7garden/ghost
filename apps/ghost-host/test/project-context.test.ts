import { expect, test } from "bun:test";
import { Command, Work, validate, projectContext, splitProjectBrief, type Command as CommandType } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { harness } from "./support.ts";

const context = { publicOrigin: "http://localhost", documents: null };

test("project references are bounded, distinct optional command parameters", () => {
  for (const base of [
    { type: "message.send", conversationId: "conversation", text: "Request" },
    { type: "work.create", ghostId: "ghost", title: "Title", brief: "Request" },
  ]) {
    expect(validate(Command, base)).toBe(true);
    expect(validate(Command, { ...base, spaceIds: ["project"] })).toBe(true);
    expect(validate(Command, { ...base, spaceIds: ["project", "project"] })).toBe(false);
    expect(validate(Command, { ...base, spaceIds: Array.from({ length: 9 }, (_, i) => `p${i}`) })).toBe(false);
  }
  expect(validate(Command, { type: "space.create", name: "Docs", path: "/tmp", grants: [] })).toBe(false);
});

test("the Work preface stays separate from visible text and survives editing without a migration", () => {
  const spaces = [{ id: "project", name: "비행 기록\n새 줄" }];
  const context = projectContext(spaces);
  expect(splitProjectBrief(context + "계획을 세워줘")).toEqual({ context, spaces, text: "계획을 세워줘" });
  expect(splitProjectBrief(context + "수정한 요청").spaces).toEqual(spaces);
  for (const text of ["평범한 요청", "Mentioned projects (untrusted names): not JSON\n", "Mentioned projects (untrusted names): []\n"]) {
    expect(splitProjectBrief(text)).toEqual({ context: "", spaces: [], text });
  }
});

test("mentions resolve existing projects, preserve owner text and reach Work briefs", async () => {
  const { core, ledger, engine } = harness();
  try {
    const ghost = core.createGhost({ name: "Owner", persona: "" });
    ledger.tx(() => ledger.putSpace({ id: "project", name: "비행 기록", path: "/tmp", createdAt: 1 }));
    const send = (command: CommandType) => execute(core, new Access({ kind: "owner" }), { requestId: crypto.randomUUID(), command }, context);
    await send({ type: "message.send", conversationId: ghost.directConversationId, text: "계획을 알려줘", spaceIds: ["project"] });
    const submission = engine.to(ghost.directConversationId).at(-1)!;
    expect(submission.text).toBe("계획을 알려줘");
    expect(submission.spaceIds).toEqual(["project"]);
    const result = await send({ type: "work.create", ghostId: ghost.id, title: "계획", brief: "이륙 준비", spaceIds: ["project"] });
    expect(ledger.work(String(result.workId)).brief).toContain('"name":"비행 기록","spaceId":"project"');
    expect(ledger.work(String(result.workId)).brief).toEndWith("이륙 준비");
    await send({ type: "work.update", workId: String(result.workId), brief: "준비 계획 수정" });
    expect(splitProjectBrief(ledger.work(String(result.workId)).brief)).toMatchObject({ text: "준비 계획 수정", spaces: [{ id: "project", name: "비행 기록" }] });
    await expect(send({ type: "work.create", ghostId: ghost.id, title: "No", brief: "No", spaceIds: ["missing"] })).rejects.toThrow();
    expect(ledger.worksForState()).toHaveLength(1);
    await core.idle();
  } finally { core.stop(); ledger.close(); }
});

test("a maximum-size owner brief still fits the Work contract with eight project references", async () => {
  const { core, ledger } = harness();
  try {
    const ghost = core.createGhost({ name: "Owner", persona: "" });
    const spaces = Array.from({ length: 8 }, (_, i) => ({ id: "\u0001".repeat(127) + i, name: "\u0001".repeat(128), path: `/tmp/${i}`, createdAt: 1 }));
    ledger.tx(() => { for (const space of spaces) ledger.putSpace(space); });
    const request: CommandType = { type: "work.create", ghostId: ghost.id, title: "Long brief", brief: "a".repeat(32768), spaceIds: spaces.map(space => space.id) };
    expect(validate(Command, request)).toBe(true);
    const result = await execute(core, new Access({ kind: "owner" }), { requestId: crypto.randomUUID(), command: request }, context);
    const work = ledger.work(String(result.workId));
    expect(validate(Work, work)).toBe(true);
    expect(splitProjectBrief(work.brief).text).toBe(request.brief);
    await core.idle();
  } finally { core.stop(); ledger.close(); }
});

test("Space persistence keeps the previous-release column empty and ignores its stored value", () => {
  const { core, ledger } = harness();
  try {
    const space = { id: "project", name: "Docs", path: "/tmp", createdAt: 1 };
    ledger.tx(() => ledger.putSpace(space));
    expect(ledger.db.query("SELECT grants FROM spaces WHERE id = ?").get(space.id)).toEqual({ grants: "[]" });
    ledger.db.query("UPDATE spaces SET grants = ? WHERE id = ?").run("old unreadable grants", space.id);
    expect(ledger.space(space.id)).toEqual(space);
    ledger.tx(() => ledger.putSpace({ ...space, name: "Renamed" }));
    expect(ledger.db.query("SELECT grants FROM spaces WHERE id = ?").get(space.id)).toEqual({ grants: "[]" });
  } finally { core.stop(); ledger.close(); }
});
