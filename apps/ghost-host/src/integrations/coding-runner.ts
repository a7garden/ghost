import type { Subprocess } from "bun";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { CodingPrefs, CodingSessionDetail, CodingSessionStart } from "@ghost/contract";
import { conflict, invalid, notFound } from "../core/errors.ts";
import { pickCodingAgent } from "./coding-agents.ts";
import { GIT, openWorktree, promptFor, WorktreeError } from "./coding-worktree.ts";
import type { CodingAgentInfo, CodingAgentPort, CodingEvent, CodingRunPort, CodingSessionWriter } from "./ports.ts";

/** One agent run in flight: its process, and whether the owner stopped it (so its ending is read as a stop, not a failure). */
interface Turn {
  child: Subprocess<"ignore", "pipe", "pipe">;
  stopped: boolean;
  /** Settles when the turn has ended and its session record is closed. */
  done: Promise<void>;
}

const MAX_RUNNING = 4;
const TURN_MINUTES = 120;
/** What an agent that failed to say anything is quoted by, from the end of its error output. */
const STDERR_CHARS = 1_500;
const ENV_KEPT = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"];

const NO_PREFS: CodingPrefs = { default: null, disabled: [] };

/** Ends an agent and the programs it started directly: a tool still running holds the output open, and the turn would never end. */
function terminate(child: Subprocess<"ignore", "pipe", "pipe">): void {
  Bun.spawnSync(["/usr/bin/pkill", "-TERM", "-P", String(child.pid)]);
  child.kill();
}

async function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([GIT, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: (out.trim() || err.trim()).slice(-20_000) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coding the owner drives from the app. A turn is one headless run of the agent: the first starts it, each later
 * message resumes the same agent conversation in the same directory. The agent runs as the owner's account, as it would
 * in a terminal, in a fresh branch worktree when the directory is a git repository, so the checkout stays clean.
 */
export class CodingRunner implements CodingRunPort {
  private readonly running = new Map<string, Turn>();

  constructor(
    private readonly agents: Pick<CodingAgentPort, "detect" | "command" | "stream" | "sessions">,
    private readonly prefs: () => CodingPrefs = () => NO_PREFS,
  ) {}

  async start(input: CodingSessionStart): Promise<CodingSessionDetail> {
    this.room();
    if (!isAbsolute(input.repo) || !existsSync(input.repo) || !statSync(input.repo).isDirectory()) throw invalid(`${input.repo} is not an absolute path of an existing directory`);
    const repo = realpathSync(input.repo);
    const picked = pickCodingAgent(await this.agents.detect(), this.prefs(), input.agent);
    if ("problem" in picked) throw invalid(picked.problem);
    let cwd = repo;
    let branch: string | null = null;
    let base: string | null = null;
    if (input.resume === undefined && input.worktree !== false) {
      const top = await git(["rev-parse", "--show-toplevel"], repo);
      if (top.code === 0) {
        base = (await git(["rev-parse", "HEAD"], top.out)).out;
        try {
          ({ path: cwd, branch } = await openWorktree(git, realpathSync(top.out), base, input.branch ?? input.task.trim().split("\n")[0]!));
        } catch (error) {
          if (error instanceof WorktreeError) throw invalid(error.message);
          throw error;
        }
      }
    }
    const writer = this.agents.sessions.open({ agent: picked.agent.id, workId: null, callId: `owner:${crypto.randomUUID()}`, task: input.task, cwd, branch, base });
    writer.step("user", input.task);
    const prompt = input.resume === undefined ? promptFor(input.task, branch) : input.task;
    this.launch(picked.agent, writer, prompt, cwd, input.resume ?? null);
    return this.detail(writer.id);
  }

  async send(id: string, text: string): Promise<CodingSessionDetail> {
    this.room();
    if (this.running.has(id)) throw conflict("this session is still working; wait for it to finish or stop it");
    const previous = this.agents.sessions.continuation(id);
    if (previous === null) {
      if (this.agents.sessions.get(id) === null) throw notFound(`coding session ${id}`);
      throw conflict("this session cannot be continued: its agent never reported a session id");
    }
    if (!existsSync(previous.cwd)) throw conflict(`the directory of this session no longer exists (${previous.cwd})`);
    const picked = pickCodingAgent(await this.agents.detect(), this.prefs(), previous.agent);
    if ("problem" in picked) throw invalid(picked.problem);
    const writer = this.agents.sessions.reopen(id);
    if (writer === null) throw conflict("this session is still working; wait for it to finish or stop it");
    writer.step("user", text);
    this.launch(picked.agent, writer, text, previous.cwd, previous.nativeId);
    return this.detail(id);
  }

  stop(id: string): CodingSessionDetail {
    const turn = this.running.get(id);
    if (turn === undefined) {
      const detail = this.detail(id);
      if (detail.session.state === "running") throw conflict("this run belongs to a Ghost's Work; cancel the Work to stop it");
      return detail;
    }
    if (!turn.stopped) {
      turn.stopped = true;
      terminate(turn.child);
    }
    return this.detail(id);
  }

  stopAll(): void {
    for (const turn of this.running.values()) {
      turn.stopped = true;
      terminate(turn.child);
    }
  }

  /** Resolves once the session's current turn, if any, has ended and been recorded. */
  async settled(id: string): Promise<void> {
    await this.running.get(id)?.done;
  }

  private room(): void {
    if (this.running.size >= MAX_RUNNING) throw conflict(`${MAX_RUNNING} sessions are already working; wait for one to finish or stop it`);
  }

  private detail(id: string): CodingSessionDetail {
    const detail = this.agents.sessions.get(id);
    if (detail === null) throw notFound(`coding session ${id}`);
    return detail;
  }

  /** Spawns one turn and follows it in the background; the session record is the only thing the caller reads. */
  private launch(agent: CodingAgentInfo, writer: CodingSessionWriter, prompt: string, cwd: string, resume: string | null): void {
    const env: Record<string, string> = { PATH: `${dirname(agent.path)}:${join(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
    for (const key of ENV_KEPT) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(this.agents.command(agent, prompt, cwd, resume), { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    } catch (error) {
      writer.step("note", `${agent.name} did not start: ${error instanceof Error ? error.message : String(error)}`);
      writer.end(127);
      throw invalid(`${agent.name} did not start`);
    }
    const turn: Turn = { child, stopped: false, done: Promise.resolve() };
    this.running.set(writer.id, turn);
    turn.done = this.follow(agent, writer, turn).finally(() => this.running.delete(writer.id));
  }

  private async follow(agent: CodingAgentInfo, writer: CodingSessionWriter, turn: Turn): Promise<void> {
    const stream = this.agents.stream(agent);
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    /** Reads a pipe to its end, or until the turn is stopped and the reader cancelled: a tool the agent left running keeps the pipe open. */
    const pump = async (pipe: ReadableStream<Uint8Array>, onText: (text: string) => void) => {
      const reader = pipe.getReader();
      readers.push(reader);
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onText(decoder.decode(value, { stream: true }));
      }
    };
    let announced = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate(turn.child); }, TURN_MINUTES * 60_000);
    const record = (events: CodingEvent[]) => {
      for (const event of events) writer.step(event.kind, event.text);
      if (!announced && stream.nativeId !== null) {
        writer.native(stream.nativeId);
        announced = true;
      }
    };
    let errors = "";
    let exitCode = 1;
    try {
      const errorsDone = pump(turn.child.stderr, (text) => { errors = (errors + text).slice(-STDERR_CHARS); });
      const outputDone = pump(turn.child.stdout, (text) => record(stream.feed(text)));
      exitCode = await turn.child.exited;
      const drain = setTimeout(() => { for (const reader of readers) void reader.cancel(); }, turn.stopped || timedOut ? 0 : 2_000);
      await Promise.all([outputDone, errorsDone]);
      clearTimeout(drain);
      record(stream.flush());
      if (turn.stopped) writer.step("note", "중지했습니다.");
      else if (timedOut) writer.step("note", `${TURN_MINUTES}분이 지나 멈췄습니다.`);
      else if (exitCode !== 0) writer.step("note", `${agent.name}이(가) 종료 코드 ${exitCode}로 끝났습니다.${errors.trim() ? `\n${errors.trim()}` : ""}`);
    } catch (error) {
      writer.step("note", `${agent.name} 실행을 따라가지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      writer.end(turn.stopped ? 130 : timedOut ? 124 : exitCode);
    }
  }
}
