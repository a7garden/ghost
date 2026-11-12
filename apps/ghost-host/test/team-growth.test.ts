import { describe, expect, test } from "bun:test";
import { CAPABILITY_GRANT, reviewOf, type CapabilityRequest, type Conversation, type Ghost } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createToolSet } from "../src/tools/index.ts";
import { harness } from "./support.ts";

const MINUTE = 60_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");

/** A main Ghost and a teammate, each with a direct conversation bound to a Pi id the tools resolve. */
function team() {
  const h = harness();
  const tools = createToolSet({ core: h.core, sandbox: { envFor: async () => undefined, workspacePath: () => "/nonexistent", stageInputs: async () => {}, release: async () => {} } as never, memory: null, documents: null, skills: null });
  const main = h.core.createGhost({ name: "Main", persona: "You lead." });
  const mate = h.core.createGhost({ name: "Mate", persona: "You research.", tools: ["web_read"] });
  const bind = (ghost: Ghost) => {
    const conversation = h.ledger.conversation(ghost.directConversationId);
    h.ledger.setPiConversationId(conversation.id, `pi-${ghost.name}`);
    return conversation;
  };
  const use = (conversation: Conversation, name: string) => {
    const ghost = h.ledger.ghost(conversation.ghostId);
    const tool = tools.extensionsFor(conversation, ghost, null).flatMap((extension) => extension.tools ?? []).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} is not offered`);
    return (args: unknown, callId: string) =>
      tool.execute(args as never, { conversationId: `pi-${ghost.name}`, callId, output: () => {}, diagnostic: () => {} } as unknown as ToolExecutionApi, context());
  };
  return { ...h, tools, main, mate, mainDirect: bind(main), mateDirect: bind(mate), use };
}

async function ownerApproves(t: ReturnType<typeof team>, callId: string) {
  const effect = t.ledger.effectByCall(t.mainDirect.id, callId)!;
  const decision = t.ledger.pendingDecisions({ effectId: effect.id })[0]!;
  await t.core.decisions.resolve(decision.id, { outcome: "approve" });
  return t.ledger.effect(effect.id);
}

describe("the main Ghost grows the team", () => {
  test("ghost_create makes a Ghost once per call, tells the owner, and stays main-only", async () => {
    const t = team();
    const create = t.use(t.mainDirect, "ghost_create");
    const first = await create({ name: "Scout", persona: "You scout sources.", reason: "조사 요청이 반복돼서 전담 Ghost를 만들었습니다." }, "create-1");
    expect(first.isError).toBeFalsy();
    expect(t.ledger.ghosts().some((ghost) => ghost.name === "Scout")).toBe(false);
    await ownerApproves(t, "create-1");
    const scout = t.ledger.ghosts().find((ghost) => ghost.name === "Scout")!;
    expect(scout.hostExecution).toBe(false);
    expect(scout.tools).not.toContain("host_read");
    expect(t.ledger.notificationsForState().some((item) => item.kind === "message" && item.title.includes("Scout"))).toBe(true);

    // A replayed call finds the Ghost it made instead of a second one.
    await create({ name: "Scout", persona: "You scout sources.", reason: "조사 요청이 반복돼서 전담 Ghost를 만들었습니다." }, "create-1");
    expect((await create({ name: "Scout", persona: "You scout sources.", reason: "Changed input" }, "create-1")).isError).toBe(true);
    expect(t.ledger.ghosts().filter((ghost) => ghost.name === "Scout")).toHaveLength(1);
    // A new call with a taken name is refused with the way forward.
    await create({ name: "Scout", persona: "x", reason: "x" }, "create-2");
    await ownerApproves(t, "create-2");
    expect(textOf(await create({ name: "Scout", persona: "x", reason: "x" }, "create-2"))).toContain("already exists");
    expect(t.ledger.ghosts().filter((ghost) => ghost.name === "Scout")).toHaveLength(1);

    expect(() => t.use(t.mateDirect, "ghost_create")).toThrow("not offered");
  });

  test("the daily creation bound stops a looping main", async () => {
    const t = team();
    const create = t.use(t.mainDirect, "ghost_create");
    const capacity = t.ledger.limits().ghostsPerDay - t.ledger.ghosts().length;
    for (let index = 0; index < capacity; index++) {
      expect((await create({ name: `G${index}`, persona: "p", reason: "r" }, `c${index}`)).isError).toBeFalsy();
      expect((await ownerApproves(t, `c${index}`)).state).toBe("done");
    }
    await create({ name: "Beyond daily bound", persona: "p", reason: "r" }, "overflow");
    const refused = await ownerApproves(t, "overflow");
    expect(refused.state).toBe("denied");
    expect(refused.result).toContain("daily Ghost creation limit");
  });
});

describe("Ghosts adapt to this environment", () => {
  test("self_adapt keeps notes apart from the persona, in the Ghost's next instructions, with the previous text kept", async () => {
    const t = team();
    const adapt = t.use(t.mateDirect, "self_adapt");
    expect((await adapt({ notes: "Docs live under docs/ in each Scope.", reason: "문서 경로가 달랐습니다." }, "a1")).isError).toBeFalsy();
    await adapt({ notes: "Docs live under docs/; read large files with host_read offset.", reason: "큰 파일" }, "a2");
    const saved = t.core.adaptations.get(t.mate.id)!;
    expect(saved).toMatchObject({ by: "self", revision: 2, previous: "Docs live under docs/ in each Scope." });
    expect(t.ledger.ghost(t.mate.id).persona).toBe("You research.");
    expect(await t.tools.contextFor(t.mateDirect, t.ledger.ghost(t.mate.id), null)).toContain("read large files with host_read offset");
    // Another Ghost's context does not carry them.
    expect(await t.tools.contextFor(t.mainDirect, t.ledger.ghost(t.main.id), null)).not.toContain("host_read offset");
    // The same notes again change nothing.
    await adapt({ notes: "Docs live under docs/; read large files with host_read offset.", reason: "again" }, "a3");
    expect(t.core.adaptations.get(t.mate.id)!.revision).toBe(2);
  });

  test("the main corrects a teammate's notes and the owner can clear them", async () => {
    const t = team();
    const update = t.use(t.mainDirect, "ghost_update");
    expect((await update({ ghost_id: t.mate.id, notes: "Use document_read before web search for project facts.", notes_reason: "프로젝트 사실을 웹에서 찾았습니다." }, "u1")).isError).toBeFalsy();
    expect(t.core.adaptations.get(t.mate.id)).toMatchObject({ by: "main" });
    t.core.adaptations.set(t.mate.id, "", "owner", "");
    expect(t.core.adaptations.get(t.mate.id)).toMatchObject({ notes: "", by: "owner" });
    expect(await t.tools.contextFor(t.mateDirect, t.ledger.ghost(t.mate.id), null)).not.toContain("What you learned");
  });
});

describe("a missing capability is asked for, not failed on", () => {
  test("a teammate's tool request accepts main advice but only the owner grants before answering", async () => {
    const t = team();
    const request = t.use(t.mateDirect, "capability_request");
    const asked = await request({ tools: ["web_search", "web_read"], reason: "출처 검색이 필요합니다." }, "r1");
    expect(asked.isError).toBeFalsy();
    const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.capability)!;
    expect(decision.proposal!.capability as CapabilityRequest).toEqual({ ghostId: t.mate.id, tools: ["web_search"], hostExecution: false });
    expect(reviewOf(decision.proposal)?.expiresAt).toBeNull();
    await tick();
    expect(t.engine.to(t.main.directConversationId).some((item) => item.requestId === `decision-review:${decision.id}`)).toBe(true);
    // Asking again while it is pending opens no second card.
    expect(textOf(await request({ tools: ["web_search"], reason: "again" }, "r2"))).toContain("already asked");

    await expect(t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "answer", answer: CAPABILITY_GRANT, note: "검색이 일에 필요합니다." })).rejects.toThrow("only the owner");
    expect(t.ledger.ghost(t.mate.id).tools).not.toContain("web_search");
    await t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "leave", note: "검색 권한을 소유자가 검토해 주세요." });
    await t.core.decisions.resolve(decision.id, { outcome: "answer", answer: CAPABILITY_GRANT });
    expect(t.ledger.ghost(t.mate.id).tools).toContain("web_search");
    expect(t.engine.to(t.mateDirect.id).at(-1)?.text).toContain("Granted: web_search");
  });

  test("PC execution is never granted on silence, and a decline grants nothing", async () => {
    const t = team();
    await t.use(t.mateDirect, "capability_request")({ host_execution: true, reason: "프로젝트 파일을 직접 읽어야 합니다." }, "r1");
    const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.capability)!;
    expect(reviewOf(decision.proposal)?.expiresAt).toBeNull();
    await t.core.decisions.settleExpired(decision.createdAt + 24 * 60 * MINUTE);
    expect(t.ledger.decision(decision.id).state).toBe("pending");
    await expect(t.core.decisions.settleForOwner(t.main.id, decision.id, { outcome: "deny", note: "컨테이너로 충분합니다." })).rejects.toThrow("only the owner");
    await t.core.decisions.resolve(decision.id, { outcome: "deny" });
    expect(t.ledger.ghost(t.mate.id).hostExecution).toBe(false);

    await t.use(t.mateDirect, "capability_request")({ host_execution: true, reason: "다시 요청합니다." }, "r2");
    const again = t.ledger.pendingDecisions().find((item) => item.proposal?.capability)!;
    await t.core.decisions.resolve(again.id, { outcome: "answer", answer: CAPABILITY_GRANT });
    expect(t.ledger.ghost(t.mate.id).hostExecution).toBe(true);
    expect(t.ledger.notificationsForState().some((item) => item.title.includes("PC 직접 실행"))).toBe(true);
  });

  test("asking for what the Ghost already holds explains instead of opening a card", async () => {
    const t = team();
    const result = await t.use(t.mateDirect, "capability_request")({ tools: ["web_read"], reason: "x" }, "r1");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("already hold");
    expect(t.ledger.pendingDecisions()).toHaveLength(0);
  });
});

test("a negative sentence starting with 허용 never grants PC execution", async () => {
  const t = team();
  await t.use(t.mateDirect, "capability_request")({ host_execution: true, reason: "필요합니다." }, "neg");
  const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.capability)!;
  await t.core.decisions.resolve(decision.id, { outcome: "answer", answer: "허용하지 마세요" });
  expect(t.ledger.ghost(t.mate.id).hostExecution).toBe(false);
});

test("recovery after answer delivery fails does not undo the owner's later revocation", async () => {
  const t = team();
  await t.use(t.mateDirect, "capability_request")({ host_execution: true, reason: "필요합니다." }, "crash");
  const decision = t.ledger.pendingDecisions().find((item) => item.proposal?.capability)!;
  const submit = t.engine.submit.bind(t.engine);
  t.engine.submit = async (conversationId, input) => {
    if (input.requestId === `decision:${decision.id}`) throw new Error("delivery failed");
    await submit(conversationId, input);
  };
  await expect(t.core.decisions.resolve(decision.id, { outcome: "answer", answer: CAPABILITY_GRANT })).rejects.toThrow("delivery failed");
  expect(t.ledger.ghost(t.mate.id).hostExecution).toBe(true);
  expect((t.ledger.decision(decision.id).proposal!.capability as CapabilityRequest).grantedAt).toBeNumber();
  const current = t.ledger.ghost(t.mate.id);
  t.ledger.tx(() => t.ledger.putGhost({ ...current, hostExecution: false }));
  t.engine.submit = submit;
  await t.core.decisions.finishResolution(decision.id);
  expect(t.ledger.ghost(t.mate.id).hostExecution).toBe(false);
  expect(t.engine.to(t.mateDirect.id).some((item) => item.requestId === `decision:${decision.id}`)).toBe(true);
});

test("two conversations asking for a capability each retain their own waiting decision", async () => {
  const t = team();
  await t.use(t.mateDirect, "capability_request")({ tools: ["web_search"], reason: "필요합니다." }, "first");
  const other = t.core.createDirectConversation(t.mate.id, "Other");
  // The fixture binds tool calls to this Ghost's Pi id; point it at the second conversation for this call.
  t.ledger.setPiConversationId(t.mateDirect.id, "old");
  t.ledger.setPiConversationId(other.id, "pi-Mate");
  await t.use(other, "capability_request")({ tools: ["web_search"], reason: "여기에도 필요합니다." }, "second");
  const decisions = t.ledger.pendingDecisions().filter((item) => item.proposal?.capability);
  expect(new Set(decisions.map((item) => item.conversationId))).toEqual(new Set([t.mateDirect.id, other.id]));
});
