import { describe, expect, it } from "vitest";
import type { Goal, Work } from "../../../../contracts/lifetime/bindings.ts";
import { threadProgressWork } from "./workThread";

const goal: Goal = {
  id: "root", revision: 3, requirement_digest: "a".repeat(64), prompt: "test",
  accountable_ghost: "primary", reply_conversation: "public", privacy: "public",
  state: "accepted", acceptance_spec: {},
};
const work = (id: string, goal_id: string, goal_revision: number, state = "accepted"): Work => ({
  id, goal_id, goal_revision, state, owner: id, owner_revision: 1,
  execution_id: null, cancellation: "none", blocker: null,
});
const link = (child_work_id: string, parent_work_id: string, parent_goal_revision?: number, current = false) => ({
  child_work_id, parent_work_id, parent_goal_revision, current,
});

describe("work thread progress", () => {
  it("retains the accepted delegation chain after expiry, scoped to the visible revision", () => {
    const entries = [
      work("old-root", "root", 2), work("root-work", "root", 3), work("grandchild", "grandchild-goal", 1),
      work("child", "child-goal", 1), work("old-child", "old-child-goal", 1),
      work("stale-link", "stale-link-goal", 1), work("cancelled", "cancelled-goal", 1, "cancelled"),
    ];
    const links = new Map([
      link("grandchild", "child", 1), link("child", "root-work", 3),
      link("old-child", "old-root", 2), link("stale-link", "root-work", 2),
      link("cancelled", "root-work", 3),
    ].map(item => [item.child_work_id, item]));

    expect(threadProgressWork(goal, entries, links).map(item => item.id)).toEqual(["root-work", "grandchild", "child"]);
    expect(threadProgressWork({ ...goal, state: "open" }, entries, links).map(item => item.id)).toEqual(["root-work"]);
  });

  it("shows active delegations with legacy link metadata and excludes stale work", () => {
    const entries = [work("root-work", "root", 3, "running"), work("live", "live-goal", 1, "running"),
      work("stale", "stale-goal", 1, "stale")];
    const links = new Map([link("live", "root-work", undefined, true), link("stale", "root-work", undefined, true)]
      .map(item => [item.child_work_id, item]));
    expect(threadProgressWork({ ...goal, state: "open" }, entries, links).map(item => item.id)).toEqual(["root-work", "live"]);
    expect(threadProgressWork(undefined, entries, links)).toEqual([]);
  });
});
