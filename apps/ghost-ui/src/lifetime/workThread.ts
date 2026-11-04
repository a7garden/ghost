import type { Artifact, Goal, Response, Work } from "../../../../contracts/lifetime/bindings.ts";
import { isArtifact, isGoal, isRecord, isWork } from "./guards";

interface FollowUp { id: string; text: string; revision: number }
interface Report extends FollowUp { created_at_ms: number }
interface Origin { id: string; text: string; created_at_ms: number }
interface GraphLink { parent_work_id: string; child_work_id: string; current: boolean }
interface BlockingEdge { waiter_work_id: string; blocker_work_id: string; kind: string }
interface GraphResult { work_id: string; artifacts: Artifact[] }

export interface WorkThread {
  goal: Goal;
  origin: Origin | null;
  follow_ups: FollowUp[];
  reports: Report[];
  follow_up_blocker: "fixed_contract" | "disclosure_changed" | "effect_unsettled" | null;
  graph: { work: Work[]; links: GraphLink[]; blocking_edges: BlockingEdge[]; results: GraphResult[]; truncated: boolean } | null;
}

export interface FollowUpDraft { text: string; revision: number }

function isTextEntry(value: unknown): value is Record<string, unknown> & { id: string; text: string } {
  return isRecord(value) && typeof value.id === "string" && Boolean(value.id) && typeof value.text === "string";
}

function isFollowUp(value: unknown): value is FollowUp {
  return isTextEntry(value) && Number.isSafeInteger(value.revision) && Number(value.revision) > 0;
}

function isOrigin(value: unknown): value is Origin {
  return isTextEntry(value) && Number.isSafeInteger(value.created_at_ms) && Number(value.created_at_ms) >= 0;
}

function isReport(value: unknown): value is Report {
  return isFollowUp(value) && isOrigin(value);
}

function isGraph(value: unknown): value is NonNullable<WorkThread["graph"]> {
  return isRecord(value) && Array.isArray(value.work) && value.work.every(isWork)
    && Array.isArray(value.links) && value.links.every(link => isRecord(link) && typeof link.child_work_id === "string"
      && typeof link.parent_work_id === "string" && typeof link.current === "boolean")
    && Array.isArray(value.blocking_edges) && value.blocking_edges.every(edge => isRecord(edge) && typeof edge.waiter_work_id === "string"
      && typeof edge.blocker_work_id === "string" && typeof edge.kind === "string")
    && Array.isArray(value.results) && value.results.every(result => isRecord(result) && typeof result.work_id === "string"
      && Array.isArray(result.artifacts) && result.artifacts.every(isArtifact))
    && typeof value.truncated === "boolean";
}

export function parseWorkThread(response: Response, goalID: string, target?: { ghost_id: string; conversation_id: string }): WorkThread {
  const data = response.data;
  if (response.status === "error" || !isRecord(data) || !isGoal(data.goal) || data.goal.id !== goalID
    || target && (data.goal.accountable_ghost !== target.ghost_id || data.goal.reply_conversation !== target.conversation_id)
    || data.origin !== null && !isOrigin(data.origin)
    || !Array.isArray(data.follow_ups) || !data.follow_ups.every(isFollowUp)
    || !Array.isArray(data.reports) || !data.reports.every(isReport)
    || data.graph !== null && !isGraph(data.graph)
    || data.follow_up_blocker != null && data.follow_up_blocker !== "fixed_contract"
      && data.follow_up_blocker !== "disclosure_changed" && data.follow_up_blocker !== "effect_unsettled") {
    throw new Error(response.status === "error" && response.summary ? response.summary : "작업 스레드를 불러오지 못했습니다.");
  }
  return { goal: data.goal, origin: data.origin, follow_ups: data.follow_ups, reports: data.reports, graph: data.graph, follow_up_blocker: data.follow_up_blocker ?? null };
}

export function followUpCommand(goal: Goal, draft: FollowUpDraft) {
  const text = draft.text.trim();
  if (!text || draft.revision !== goal.revision) return null;
  const prompt = `${goal.prompt}\n\nOwner follow-up:\n${text}`;
  const encoder = new TextEncoder();
  if (encoder.encode(text).length > 16_384 || encoder.encode(prompt).length > 65_536) return null;
  return { method: "goal.update", goal_id: goal.id, prompt, acceptance_spec: goal.acceptance_spec, follow_up: text };
}

export function workThreadTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0];
  if (!line) return "작업 스레드";
  const characters = Array.from(line);
  return characters.length > 96 ? `${characters.slice(0, 96).join("")}…` : line;
}
