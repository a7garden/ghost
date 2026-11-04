import { describe, expect, it } from "vitest";
import type { ConversationRun, Response } from "../../../../contracts/lifetime/bindings.ts";
import { defaultRegistryGhostId, findRegisteredConversation, mergeConversationRuns, mergeConversationTurns, parseConversationPage, parseRegistryResponse } from "./conversation";

const target = {
  ghost_id: "11111111-1111-4111-8111-111111111111",
  conversation_id: "22222222-2222-4222-8222-222222222222",
};

const canonicalTurn = {
  id: "turn-3",
  sequence: 3,
  sender_kind: "owner",
  sender_ref: "owner",
  text: "Canonical owner message",
  privacy: "private",
  kind: "user",
  source_turn_id: null,
  attachments: [],
  created_at_ms: 1_700_000_000_000,
};

function pageResponse(conversationId = target.conversation_id, turns = [canonicalTurn]): Response {
  return {
    status: "success",
    summary: "Canonical conversation page",
    object_refs: [],
    artifacts: [],
    next_actions: [],
    error_code: null,
    retry_class: "never",
    data: {
      ...target,
      conversation_id: conversationId,
      privacy: "private",
      turns,
      turn_runs: [],
      has_older: false,
      oldest_sequence: turns[0]?.sequence ?? null,
    },
  };
}

describe("registered conversation selection", () => {
  const canonical = { ...target, kind: "primary", roles: [], mode: "active" };
  const secondary = { ...canonical, conversation_id: "11111111-1111-4111-8111-111111111111", secondary: true };
  const read = (...registry: unknown[]) => parseRegistryResponse({ ...pageResponse(), data: { registry } });

  it("keeps the canonical default when a secondary pair sorts first and requires exact IDs for secondary routes", () => {
    const entries = read(canonical, secondary);
    expect(entries[0]).toEqual(secondary);
    expect(defaultRegistryGhostId(entries)).toBe(canonical.ghost_id);
    expect(findRegisteredConversation(entries, canonical.ghost_id)).toEqual(canonical);
    expect(findRegisteredConversation(entries, canonical.ghost_id, secondary.conversation_id)).toEqual(secondary);
    expect(findRegisteredConversation(entries, canonical.ghost_id, "unregistered")).toBeUndefined();
    expect(findRegisteredConversation(entries, "other-ghost", secondary.conversation_id)).toBeUndefined();
    expect(defaultRegistryGhostId(read(secondary))).toBeNull();
    expect(findRegisteredConversation(read(secondary), canonical.ghost_id)).toBeUndefined();
  });

  it("rejects contradictory classifications for the same pair", () => {
    expect(() => read(canonical, { ...canonical, secondary: true })).toThrow();
  });
});

describe("canonical conversation pages", () => {
  it("keeps a link learned after the original turn when an older page omits it", () => {
    const read = (turn: typeof canonicalTurn) => parseConversationPage(pageResponse(target.conversation_id, [turn]), target).turns;
    const first = read(canonicalTurn);
    const later = read(Object.assign({}, canonicalTurn, { work_thread_ids: ["work-a"] }));
    const second = read(Object.assign({}, canonicalTurn, { work_thread_ids: ["work-b"] }));
    expect(mergeConversationTurns(mergeConversationTurns(mergeConversationTurns(first, later), second), first))
      .toEqual([{ ...canonicalTurn, work_thread_ids: ["work-a", "work-b"] }]);
  });

  it("allows a canonical report to link back to its work and rejects advisory links without a report origin", () => {
    const report = { ...canonicalTurn, kind: "assistant_advisory", sender_kind: "ghost", origin_report_id: "report-1", work_thread_ids: ["work-a"] };
    expect(parseConversationPage(pageResponse(target.conversation_id, [report]), target).turns[0]?.work_thread_ids).toEqual(["work-a"]);
    expect(() => parseConversationPage(pageResponse(target.conversation_id, [{ ...report, origin_report_id: undefined }]), target)).toThrow();
  });

  it("rejects a page for a different registered conversation", () => {
    expect(() => parseConversationPage(
      pageResponse("33333333-3333-4333-8333-333333333333"),
      target,
    )).toThrow();
  });

  it("rejects turns that are not in strictly increasing canonical sequence order", () => {
    const turns = [
      { ...canonicalTurn, id: "turn-4", sequence: 4 },
      { ...canonicalTurn, id: "turn-3", sequence: 3 },
    ];
    expect(() => parseConversationPage(pageResponse(target.conversation_id, turns), target))
      .toThrow();
  });

  it.each([
    { turn_id: canonicalTurn.id, ghost_id: "foreign-ghost" },
    { turn_id: "turn-outside-returned-page", ghost_id: target.ghost_id },
  ])("rejects controller state outside the returned Owner scope: $turn_id / $ghost_id", foreign => {
    const response = pageResponse();
    const data = response.data as Record<string, unknown>;
    data.turn_runs = [{
      ...target, ...foreign, state: "running", cancel_requested: false,
      cancel_command_id: null, submission_id: null, entry_id: null,
      reason_code: null, latest_status_command_id: null,
      created_at_ms: canonicalTurn.created_at_ms,
      updated_at_ms: canonicalTurn.created_at_ms,
    }];
    expect(() => parseConversationPage(response, target)).toThrow();
  });

  it("does not treat an assistant row's own identity as an Owner controller turn", () => {
    const advisory = { ...canonicalTurn, id: "advisory-4", sequence: 4, kind: "assistant_advisory", source_turn_id: canonicalTurn.id };
    const response = pageResponse(target.conversation_id, [canonicalTurn, advisory]);
    const data = response.data as Record<string, unknown>;
    data.turn_runs = [{
      ...target, turn_id: advisory.id, state: "answered", cancel_requested: false,
      cancel_command_id: null, submission_id: null, entry_id: null,
      reason_code: null, latest_status_command_id: null,
      created_at_ms: canonicalTurn.created_at_ms,
      updated_at_ms: canonicalTurn.created_at_ms,
    }];
    expect(() => parseConversationPage(response, target)).toThrow();
  });
});

describe("controller progress from overlapping conversation reads", () => {
  it("keeps requested cancellation separate from completion and cannot be rolled back by an older page", () => {
    const running: ConversationRun = {
      ...target, turn_id: canonicalTurn.id, state: "running", cancel_requested: false,
      cancel_command_id: null, submission_id: "13", entry_id: null,
      reason_code: null, latest_status_command_id: "status-running",
      created_at_ms: 10, updated_at_ms: 20,
    };
    const requested: ConversationRun = {
      ...running, cancel_requested: true, cancel_command_id: "cancel-original", updated_at_ms: 21,
    };
    const pending = mergeConversationRuns(new Map([[running.turn_id, running]]), [requested]);
    expect(pending.get(running.turn_id)?.state).toBe("running");
    expect(pending.get(running.turn_id)?.cancel_requested).toBe(true);
    const cancelled: ConversationRun = {
      ...requested, state: "cancelled", reason_code: "owner_cancelled",
      latest_status_command_id: "status-cancelled", updated_at_ms: 22,
    };
    const completed = mergeConversationRuns(pending, [cancelled]);
    const reordered = mergeConversationRuns(completed, [running, requested]);
    const observed = reordered.get(running.turn_id)!;
    expect(observed.state).toBe("cancelled");
    expect(observed.cancel_requested).toBe(true);
    expect(observed.cancel_command_id).toBe("cancel-original");
    expect(observed.submission_id).toBe("13");
    expect(observed.reason_code).toBe("owner_cancelled");
  });
});
