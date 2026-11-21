import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { CodingAgentId, CodingStep, validate, type CodingSessionDetail, type CodingSessionView } from "@ghost/contract";
import type { CodingSessionOpen, CodingSessionStore, CodingSessionWriter } from "./ports.ts";

/** One line of a session file. The file is append-only: start, then steps, native id and end as they happen. */
const Line = Type.Union([
  Type.Object({
    t: Type.Literal("start"),
    id: Type.String(),
    at: Type.Integer(),
    agent: CodingAgentId,
    workId: Type.Union([Type.String(), Type.Null()]),
    callId: Type.String(),
    task: Type.String(),
    cwd: Type.String(),
    branch: Type.Union([Type.String(), Type.Null()]),
    base: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({ t: Type.Literal("native"), id: Type.String() }),
  Type.Object({ t: Type.Literal("step"), at: Type.Integer(), kind: CodingStep.properties.kind, text: Type.String() }),
  Type.Object({ t: Type.Literal("end"), at: Type.Integer(), exitCode: Type.Integer() }),
]);
type Line = Static<typeof Line>;
type Start = Extract<Line, { t: "start" }>;

const STEP_CHARS = 4_000;
/** A session file stops growing here; the viewer then says so instead of silently dropping the rest. */
const MAX_BYTES = 1_500_000;
const KEEP_DAYS = 90;
const ID = /^[0-9a-f]{32}$/;

/** What the owner types in a terminal to carry on a session by hand. */
function resumeCommand(agent: CodingAgentId, cwd: string, nativeId: string | null): string | null {
  if (nativeId === null) return null;
  const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`;
  return `cd ${quoted} && ${agent === "codex" ? `codex resume ${nativeId}` : `${agent} --resume ${nativeId}`}`;
}

/**
 * Every `code_run` as a file under `<state root>/coding-sessions/<id>.jsonl`: who ran where, what the agent said and
 * did, how it ended. A file instead of a ledger table keeps the ledger schema (and so rollback) untouched. Files older
 * than ninety days are removed when a new session opens.
 */
export class CodingSessions implements CodingSessionStore {
  private readonly live = new Set<string>();

  constructor(private readonly dir: string) {}

  open(meta: CodingSessionOpen): CodingSessionWriter {
    mkdirSync(this.dir, { recursive: true });
    this.prune();
    const id = crypto.randomUUID().replaceAll("-", "");
    const path = join(this.dir, `${id}.jsonl`);
    const start: Start = { t: "start", id, at: Date.now(), ...meta };
    writeFileSync(path, `${JSON.stringify(start)}\n`, { mode: 0o600 });
    this.live.add(id);
    let size = 0;
    let capped = false;
    const append = (line: Line) => {
      const text = `${JSON.stringify(line)}\n`;
      appendFileSync(path, text);
      size += text.length;
    };
    return {
      id,
      native: (nativeId) => append({ t: "native", id: nativeId }),
      step: (kind, text) => {
        if (capped) return;
        if (size >= MAX_BYTES) {
          capped = true;
          append({ t: "step", at: Date.now(), kind: "note", text: "이 세션 기록이 한도에 닿아 여기서 멈춥니다. 에이전트의 전체 대화는 이어받기 명령으로 열 수 있습니다." });
          return;
        }
        append({ t: "step", at: Date.now(), kind, text: text.length > STEP_CHARS ? `${text.slice(0, STEP_CHARS - 1)}…` : text });
      },
      end: (exitCode) => {
        append({ t: "end", at: Date.now(), exitCode });
        this.live.delete(id);
      },
    };
  }

  list(limit = 30, workId?: string): CodingSessionView[] {
    const sessions: CodingSessionView[] = [];
    for (const { id } of this.files().sort((a, b) => b.mtime - a.mtime)) {
      if (sessions.length >= limit) break;
      const detail = this.get(id);
      if (detail && (workId === undefined || detail.session.workId === workId)) sessions.push(detail.session);
    }
    return sessions;
  }

  get(id: string, after = 0): CodingSessionDetail | null {
    const folded = this.fold(id);
    if (folded === null) return null;
    const { start, nativeId, ended, steps } = folded;
    const state = ended ? (ended.exitCode === 0 ? "done" : "failed") : this.live.has(id) ? "running" : "interrupted";
    return {
      session: {
        id,
        agent: start.agent,
        workId: start.workId,
        callId: start.callId,
        task: start.task,
        cwd: start.cwd,
        branch: start.branch,
        nativeId,
        resumeCommand: resumeCommand(start.agent, start.cwd, nativeId),
        startedAt: start.at,
        endedAt: ended?.at ?? null,
        state,
        exitCode: ended?.exitCode ?? null,
      },
      steps: steps.slice(after),
      next: steps.length,
    };
  }

  /** What `code_run` needs to continue a session: where it ran, the agent's own id for it, and the base it branched from. */
  continuation(id: string): { agent: CodingAgentId; cwd: string; branch: string | null; base: string | null; nativeId: string } | null {
    const folded = this.fold(id);
    if (folded === null || folded.nativeId === null) return null;
    const { start } = folded;
    return { agent: start.agent, cwd: start.cwd, branch: start.branch, base: start.base, nativeId: folded.nativeId };
  }

  private fold(id: string): { start: Start; nativeId: string | null; ended: { at: number; exitCode: number } | null; steps: CodingSessionDetail["steps"] } | null {
    if (!ID.test(id)) return null;
    let raw: string;
    try { raw = readFileSync(join(this.dir, `${id}.jsonl`), "utf8"); } catch { return null; }
    let start: Start | null = null;
    let nativeId: string | null = null;
    let ended: { at: number; exitCode: number } | null = null;
    const steps: CodingSessionDetail["steps"] = [];
    for (const text of raw.split("\n")) {
      if (text === "") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (!validate(Line, parsed)) continue;
      if (parsed.t === "start") start = parsed;
      else if (parsed.t === "native") nativeId = parsed.id;
      else if (parsed.t === "end") ended = parsed;
      else steps.push({ at: parsed.at, kind: parsed.kind, text: parsed.text });
    }
    return start === null ? null : { start, nativeId, ended, steps };
  }

  /** The session files in the folder, with when each last changed; anything else in there is not ours. */
  private files(): { id: string; path: string; mtime: number }[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.flatMap((name) => {
      const id = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || !ID.test(id)) return [];
      const path = join(this.dir, name);
      try { return [{ id, path, mtime: statSync(path).mtimeMs }]; } catch { return []; }
    });
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const file of this.files()) {
      if (file.mtime >= cutoff) continue;
      try { unlinkSync(file.path); } catch { /* a file that vanished is already pruned */ }
    }
  }
}
