import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AUTONOMOUS_WAKE, type AutonomyPlan, type Ghost, type Space, type Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import { CommandError, conflict, forbidden, invalid } from "./errors.ts";
import { digestOf } from "./ids.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The nearest and farthest a plan may look ahead. */
export const PLAN_MIN_MINUTES = 10;
export const PLAN_MAX_MINUTES = 14 * 24 * 60;
/** A watched project change wakes a Ghost early, but not more often than this. */
const WATCH_GAP = HOUR;
/** A wake that ends without a new plan looks again after this. */
const FALLBACK = DAY;
/** First plans are spread so a fresh team does not wake at once. */
const FIRST_SPREAD = 2 * HOUR;
const TICK = MINUTE;

/** A wake recorded before submission, so a retry after a crash reuses its exact request id and text. */
interface PendingWake {
  requestId: string;
  text: string;
  at: number;
  heads: Record<string, string>;
  /** The plan revision this record created; a later revision means the plan changed during the wake. */
  revision: number;
}

/** Persisted per Ghost in `settings` (`autonomy:<ghostId>`): no ledger migration, older releases ignore it. */
interface Stored extends AutonomyPlan {
  day: string;
  heads: Record<string, string>;
  /** Bumped on every write, so a write prepared before an await can tell it went stale. */
  revision: number;
  /** Wakes ever submitted; part of each request id, so a repeated situation still wakes. */
  wakes: number;
  pending: PendingWake | null;
  /** When the last prepared wake prompt was built. Admission time proves nothing about what it observed. */
  observed: number | null;
  /** Monotonic ledger boundary of the prepared prompt, including equal/backward wall-clock changes. */
  observedSeq: number | null;
}

export interface PlanInput {
  at: number;
  intent: string;
  watch?: string[];
}

export interface AutonomyDeps {
  /** A Space's Git position (`branch@sha`), or null outside a repository. */
  head?: (path: string) => Promise<string | null>;
  /** Commit subjects between two positions of the repository holding `path`. */
  commits?: (path: string, from: string, to: string) => Promise<string[]>;
}

const key = (ghostId: string) => `autonomy:${ghostId}`;
const localDay = (at: number) => new Date(at).toLocaleDateString("en-CA");
const stamp = (at: number) =>
  new Date(at).toLocaleString("en-CA", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const spread = (ghostId: string) => Number.parseInt(digestOf(ghostId).slice(0, 8), 16) % FIRST_SPREAD;
const isMain = (ghost: Ghost) => ghost.isDefault && ghost.state === "active" && ghost.deletedAt === null;
const live = (work: Work) => !["done", "failed", "cancelled"].includes(work.state);

/**
 * Self-directed Ghosts. Every active Ghost decides when it next looks at its world (`plan_next`), and the
 * Host keeps that appointment with an `[Autonomous wake]` in its direct conversation — earlier when a
 * project it watches moves. The Ghost then chooses what, if anything, to do. Wakes are deterministic
 * Pi submissions recorded before they are sent, bounded per day and across the team.
 */
export class Autonomy {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Ghosts whose self-directed turn may still be running; counts against the team-wide limit. */
  private readonly awake = new Set<string>();
  private seeded = false;
  private inFlight: Promise<void> | null = null;
  private readonly head: (path: string) => Promise<string | null>;
  private readonly commits: (path: string, from: string, to: string) => Promise<string[]>;

  constructor(private readonly core: Core, deps: AutonomyDeps = {}) {
    this.head = deps.head ?? repositoryHead;
    this.commits = deps.commits ?? commitSubjects;
  }

  start() {
    if (this.running) return;
    this.running = true;
    // First look at once: seed plans and keep appointments a restart delayed.
    this.arm(0);
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.inFlight;
  }

  private arm(delay: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => this.core.log("autonomy tick failed", error))
        .finally(() => this.arm(TICK));
    }, delay);
  }

  tick(now = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.wake(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The owner-visible plans of every listed Ghost. */
  view(): AutonomyPlan[] {
    return this.ghosts().map((ghost) => this.public(this.load(ghost.id)));
  }

  /** Whether the owner left this Ghost's self-directed drive on. */
  enabled(ghostId: string): boolean {
    return this.load(ghostId).enabled;
  }

  /**
   * Whether this Ghost is offered plan_next at all: the active main Ghost plans teammates even with its own
   * drive off; any other Ghost only while its own drive is on. The tool grant and the prompt both ask here,
   * so they cannot drift from `authorize`.
   */
  offersPlanning(ghost: Ghost): boolean {
    // 2026.11.11 : 메인이라도 자기 구동이 꺼지고 구동이 켜진 동료도 없으면 plan_next 는 어느 대상이든 거절된다.
    // 그때 도구를 주면 첫 호출이 거절되는 막다른 길이 메인에게만 남는다.
    return this.enabled(ghost.id) || this.plansTeam(ghost) && this.teammatesOn(ghost) > 0;
  }

  /** Active teammates whose drive is on — the only ones plan_next can target for the main Ghost. */
  teammatesOn(ghost: Ghost): number {
    return this.core.ledger.ghosts()
      .filter((item) => item.id !== ghost.id && item.deletedAt === null && item.state === "active" && this.enabled(item.id)).length;
  }

  /** Whether this Ghost plans its teammates' looks: the active main Ghost only. */
  plansTeam(ghost: Ghost): boolean {
    return isMain(ghost);
  }

  setEnabled(ghostId: string, enabled: boolean): AutonomyPlan {
    const ghost = this.core.ledger.ghost(ghostId);
    if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted`);
    return this.update(ghost.id, (stored) => ({ ...stored, enabled, nextAt: enabled ? stored.nextAt : null, pending: enabled ? stored.pending : null }));
  }

  /**
   * A teammate Work outcome or blocker pulls the current main's next look forward. The plan write is the
   * whole durable signal: `wake()` stays the only admission path, so duty, the daily budget, busy
   * conversations and the concurrency cap still gate the model turn, and an owner-disabled drive or a
   * pending wake keeps its identity. A change that lands between a prompt's preparation and its
   * admission must not vanish under the fallback: the revision bump makes the admission keep a due
   * follow-up instead of installing the day-long fallback, and `observed` keeps the next prompt's
   * evidence window honest. Evidence the prepared prompt already saw changes nothing.
   */
  async teamChanged(work: Work): Promise<void> {
    const main = this.core.ledger.defaultGhost();
    if (!main || main.state !== "active" || main.deletedAt !== null) return;
    const now = Date.now();
    const changeSeq = this.core.ledger.workChangeSeq(work.id);
    this.update(main.id, (stored) => {
      if (!stored.enabled) return stored;
      if (stored.observedSeq !== null && changeSeq !== null) {
        if (changeSeq <= stored.observedSeq) return stored;
      } else if (work.updatedAt < (stored.observed ?? 0)) return stored;
      return { ...stored, nextAt: Math.min(stored.nextAt ?? now, now) };
    });
    void this.tick().catch((error) => this.core.log(`team change from ${work.id} failed to admit ${main.name}'s look`, error));
  }

  /**
   * A new owner goal pulls the current main's next look forward. Like a team change, the plan write is the
   * whole signal: `wake()` still applies duty, the daily budget, busy conversations and the concurrency cap,
   * and a pending wake keeps its identity. A wake prepared before the goal existed does not carry it; the
   * revision bump keeps a due follow-up after that wake instead of the day-long fallback.
   */
  goalsChanged(): void {
    const main = this.core.ledger.defaultGhost();
    if (!main || main.state !== "active" || main.deletedAt !== null) return;
    const now = Date.now();
    this.update(main.id, (stored) => (stored.enabled ? { ...stored, nextAt: Math.min(stored.nextAt ?? now, now) } : stored));
    void this.tick().catch((error) => this.core.log(`a new goal failed to admit ${main.name}'s look`, error));
  }

  /**
   * Record when a Ghost looks again. `by` is the caller: the Ghost itself, or the main Ghost planning a
   * teammate. Watched Spaces start from their current position, so only later changes wake early.
   */
  async plan(by: Ghost, targetId: string, input: PlanInput, now = Date.now()): Promise<AutonomyPlan> {
    const ahead = input.at - now;
    if (ahead < PLAN_MIN_MINUTES * MINUTE - 1000) throw invalid(`plan at least ${PLAN_MIN_MINUTES} minutes ahead`);
    if (ahead > PLAN_MAX_MINUTES * MINUTE) throw invalid("plan at most 14 days ahead");
    const intent = input.intent.trim();
    if (!intent) throw invalid("say why you will look again");
    const target = this.authorize(by.id, targetId);
    let watched: { watch: string[]; heads: Record<string, string> } | null = null;
    if (input.watch) {
      const spaces = new Map(this.core.ledger.spaces().map((space) => [space.id, space]));
      const unknown = input.watch.filter((id) => !spaces.has(id));
      if (unknown.length) throw invalid(`unknown project ${unknown[0]}`);
      const known = this.load(target.id).heads;
      const watch = [...new Set(input.watch)].slice(0, 8);
      const heads: Record<string, string> = {};
      for (const id of watch) heads[id] = known[id] ?? (await this.head(spaces.get(id)!.path).catch(() => null)) ?? "";
      watched = { watch, heads };
    }
    // Authority is checked again after the repository reads: a switch-off or a new main meanwhile wins.
    return this.update(target.id, (stored) => {
      this.authorize(by.id, target.id);
      return { ...stored, ...watched, nextAt: input.at, intent: intent.slice(0, 1024), setBy: target.id === by.id ? "self" : "main" };
    });
  }

  /** From the current ledger: a Ghost plans itself; only the current main plans a non-default teammate. */
  private authorize(callerId: string, targetId: string): Ghost {
    const caller = this.core.ledger.ghost(callerId);
    const target = this.core.ledger.ghost(targetId);
    if (target.id !== caller.id) {
      if (!isMain(caller)) throw forbidden("only the main Ghost plans another Ghost's next look");
      if (target.isDefault) throw forbidden("the main Ghost plans its own time");
    }
    if (target.deletedAt !== null || target.state !== "active") throw conflict(`${target.name} is not active`);
    if (!this.load(target.id).enabled) throw conflict(`the owner switched off ${target.name}'s self-directed drive`);
    return target;
  }

  private ghosts(): Ghost[] {
    return this.core.ledger.ghosts().filter((ghost) => ghost.deletedAt === null);
  }

  private load(ghostId: string): Stored {
    const stored = this.core.ledger.setting<Partial<Stored> | null>(key(ghostId), null);
    return {
      ghostId, enabled: true, nextAt: null, intent: "", setBy: "host", watch: [], lastWakeAt: null, wakesToday: 0,
      day: "", heads: {}, revision: 0, wakes: 0, pending: null, observed: null, observedSeq: null,
      ...stored,
    };
  }

  /** Read, change and write one Ghost's plan synchronously, so nothing interleaves. Returning the input unchanged writes nothing. */
  private update(ghostId: string, change: (stored: Stored) => Stored): AutonomyPlan {
    return this.core.ledger.tx(() => {
      const current = this.load(ghostId);
      const next = change(current);
      if (next === current) return this.public(current);
      const stored: Stored = { ...next, ghostId, revision: current.revision + 1 };
      const view = this.public(stored);
      this.core.ledger.putSetting(key(ghostId), stored);
      this.core.ledger.emit({ type: "autonomy", plan: view });
      return view;
    });
  }

  private public(stored: Stored): AutonomyPlan {
    const { ghostId, enabled, nextAt, intent, setBy, watch, lastWakeAt, wakesToday } = stored;
    return { ghostId, enabled, nextAt, intent, setBy, watch, lastWakeAt, wakesToday };
  }

  private async wake(now: number) {
    // 퇴근 중에는 자율 깨우기를 하지 않는다. 계획은 그대로 남아 출근하면 깨운다.
    if (!this.core.duty.onDuty(now)) return;
    const ledger = this.core.ledger;
    const busy = (ghost: Ghost) => ledger.findConversation(ghost.directConversationId)?.busy === true;
    const ghosts = this.ghosts().filter((ghost) => ghost.state === "active");
    if (!this.seeded) {
      // After a restart, self-directed turns Pi resumes still hold their slots, however long they run.
      this.seeded = true;
      for (const ghost of ghosts) {
        const stored = this.load(ghost.id);
        if ((stored.lastWakeAt !== null || stored.pending !== null) && busy(ghost)) this.awake.add(ghost.id);
      }
    }
    for (const id of [...this.awake]) {
      const ghost = ghosts.find((item) => item.id === id);
      if (!ghost || !busy(ghost)) this.awake.delete(id);
    }
    const spaces = new Map(ledger.spaces().map((space) => [space.id, space]));
    const heads = new Map<string, string>();
    const headOf = async (space: Space) => {
      if (!heads.has(space.id)) heads.set(space.id, (await this.head(space.path).catch(() => null)) ?? "");
      return heads.get(space.id)!;
    };
    const order = [...ghosts].sort((a, b) => (this.load(a.id).nextAt ?? Infinity) - (this.load(b.id).nextAt ?? Infinity));
    for (const ghost of order) {
      const plan = this.load(ghost.id);
      if (!plan.enabled) continue;
      if (plan.pending) {
        // Admitted or not before a crash: the same request id lets Pi tell.
        if (busy(ghost) || this.awake.size >= this.core.ledger.limits().concurrentWakes) continue;
        await this.submit(ghost, plan.pending, now);
        continue;
      }
      if (plan.nextAt === null) {
        this.update(ghost.id, (stored) => (stored.nextAt === null ? { ...stored, nextAt: now + spread(ghost.id), setBy: "host" } : stored));
        continue;
      }
      const wakesToday = plan.day === localDay(now) ? plan.wakesToday : 0;
      const moved: { space: Space; from: string; to: string }[] = [];
      for (const id of plan.watch) {
        const space = spaces.get(id);
        if (!space) continue;
        const to = await headOf(space);
        const from = plan.heads[id] ?? "";
        if (to && to !== from) moved.push({ space, from, to });
      }
      const due = now >= plan.nextAt;
      const early = !due && moved.length > 0 && (plan.lastWakeAt === null || now - plan.lastWakeAt >= WATCH_GAP);
      if (!due && !early) continue;
      if (wakesToday >= this.core.ledger.limits().dailyWakes) {
        if (due) {
          const tomorrow = new Date(now);
          tomorrow.setHours(24, 0, 0, 0);
          this.update(ghost.id, (stored) => (stored.revision === plan.revision ? { ...stored, nextAt: tomorrow.getTime() + spread(ghost.id), setBy: "host" } : stored));
        }
        continue;
      }
      if (busy(ghost)) continue;
      if (this.awake.size >= this.core.ledger.limits().concurrentWakes) break;
      const observedSeq = ledger.seq();
      const text = await this.prompt(ghost, plan, due, moved, now);
      const seen = { ...plan.heads };
      for (const item of moved) seen[item.space.id] = item.to;
      // Recorded before submission; skipped when the owner or the Ghost changed the plan meanwhile.
      let pending = null as PendingWake | null;
      this.update(ghost.id, (stored) => {
        if (stored.revision !== plan.revision || !stored.enabled || stored.pending) return stored;
        pending = { requestId: `autonomy:${ghost.id}:${stored.wakes + 1}:${now}`, text, at: now, heads: seen, revision: stored.revision + 1 };
        // Capture before prompt I/O. A later ledger change remains unobserved even on the same clock tick.
        return { ...stored, pending, observed: now, observedSeq };
      });
      if (pending) await this.submit(ghost, pending, now);
    }
  }

  /** Submit a recorded wake, then account for it. A plan the Ghost makes during the wake outlives the fallback. */
  private async submit(ghost: Ghost, pending: PendingWake, now: number) {
    try {
      await this.core.engine.submit(ghost.directConversationId, { text: pending.text, origin: "schedule", requestId: pending.requestId });
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      // No model or credential: an outcome, not a crash. Look again later instead of every minute.
      this.core.log(`autonomy wake for ${ghost.name} skipped`, error.message);
      this.update(ghost.id, (stored) => {
        if (stored.pending?.requestId !== pending.requestId) return stored;
        return stored.revision === pending.revision ? { ...stored, pending: null, nextAt: now + 6 * HOUR, setBy: "host" } : { ...stored, pending: null };
      });
      return;
    }
    this.awake.add(ghost.id);
    this.update(ghost.id, (stored) => {
      if (stored.pending?.requestId !== pending.requestId) return stored;
      // Charged to the day it was admitted, which a recovered wake may not share with its record.
      const day = localDay(now);
      const replanned = stored.revision !== pending.revision;
      return {
        ...stored,
        pending: null,
        heads: { ...stored.heads, ...pending.heads },
        lastWakeAt: now,
        day,
        wakesToday: (stored.day === day ? stored.wakesToday : 0) + 1,
        wakes: stored.wakes + 1,
        ...(replanned ? {} : { nextAt: now + FALLBACK, setBy: "host" as const }),
      };
    });
  }

  /** What the Ghost needs to decide on its own: its plan, what changed, what is live, and for the main Ghost the team. */
  private async prompt(ghost: Ghost, plan: Stored, due: boolean, moved: { space: Space; from: string; to: string }[], now: number): Promise<string> {
    const ledger = this.core.ledger;
    const names = new Map(ledger.ghosts().map((item) => [item.id, item.name]));
    const planner = plan.setBy === "self" ? "you" : plan.setBy === "main" ? `the main Ghost ${names.get(ledger.defaultGhost()?.id ?? "") ?? ""}`.trim() : "the Host";
    const lines = [`${AUTONOMOUS_WAKE} ${stamp(now)}`];
    lines.push(plan.intent ? `Plan (set by ${planner}): ${plan.intent}` : "Plan: none yet. This is your first self-directed wake: look at your role and the owner's projects and decide what is worth doing.");
    if (!due) lines.push(`Trigger: a project you watch changed (${moved.map((item) => item.space.name).join(", ")}).`);
    // Admission time proves nothing about what the prepared prompt observed; `observed` is when it was built.
    const since = plan.observed ?? plan.lastWakeAt ?? now - DAY;
    const sinceLabel = plan.observed === null && plan.lastWakeAt === null ? "yesterday" : stamp(since);
    lines.push("", `Since ${sinceLabel}:`);
    const settled = ledger.settledRootsSince(since, plan.observedSeq, ghost.isDefault ? null : ghost.id);
    if (settled.count > 0) {
      // Ids, state and failure reasons travel so the main can work_inspect the exact task.
      lines.push(`${ghost.isDefault ? "Team" : "Your"} settled Work: ${settled.count}`);
      for (const work of settled.works) {
        const reason = work.reason ? ` — ${work.reason.split("\n", 1)[0]!.slice(0, 200)}` : "";
        lines.push(`- "${work.title}" (${work.id}) — ${names.get(work.ghostId) ?? "?"} — ${work.state}${reason}`);
      }
      if (settled.count > settled.works.length) lines.push(`+${settled.count - settled.works.length} more: work_list shows all, work_inspect takes a row's id`);
    }
    for (const item of moved) {
      const subjects = item.from ? await this.commits(item.space.path, item.from, item.to).catch(() => []) : [];
      lines.push(`- Project ${item.space.name}: ${subjects.length ? subjects.slice(0, 8).join(" · ") : "new commits"}`);
    }
    const pending = ledger.decisionsForState().filter((decision) => decision.state === "pending");
    if (pending.length) lines.push(`- ${pending.length} decision(s) waiting for the owner`);
    if (settled.count === 0 && moved.length === 0 && pending.length === 0) lines.push("- nothing new reached the Host");
    // Every Ghost sees the team's directions and boundaries; ids let it link Work to an active milestone.
    const goals = this.core.goals.context();
    if (goals) lines.push("", goals);
    const mine = ledger.worksInState("queued", "running", "waiting", "verifying", "blocked").filter((work) => work.ghostId === ghost.id && live(work));
    if (mine.length) lines.push("", "Your live Work:", ...mine.slice(0, 8).map((work) => `- "${work.title}" ${work.state}`));
    // The main connects the team: its wake also carries every live teammate Work and blocker, bounded; everyone else stays scoped to their own Work.
    if (ghost.isDefault) {
      const team = this.core.team.context();
      if (team) lines.push("", team);
    }
    if (plan.watch.length) {
      const spaces = new Map(ledger.spaces().map((space) => [space.id, space.name]));
      lines.push("", `Watching: ${plan.watch.map((id) => spaces.get(id) ?? id).join(", ")}`);
    }
    if (ghost.isDefault) {
      const team = this.ghosts().filter((item) => item.id !== ghost.id && item.state === "active");
      const rows = team.map((item) => {
        const other = this.load(item.id);
        if (!other.enabled) return `- ${item.name} (${item.id}): self-directed drive off`;
        const next = other.nextAt === null ? "unplanned" : stamp(other.nextAt);
        return `- ${item.name} (${item.id}): next ${next}${other.intent ? ` — ${other.intent.slice(0, 160)}` : ""}`;
      });
      if (rows.length) lines.push("", "Team plans:", ...rows);
    }
    lines.push("", "Decide on your own what is worth doing now, then call plan_next.");
    return lines.join("\n");
  }
}

/** `branch@sha` of the repository holding `path`, read from Git's files without running Git. */
export async function repositoryHead(path: string): Promise<string | null> {
  let directory = resolve(path);
  for (;;) {
    const candidate = join(directory, ".git");
    const info = await stat(candidate).catch(() => null);
    if (info) {
      let gitDir = candidate;
      if (info.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, "utf8"))?.[1]?.trim();
        if (!pointer) return null;
        gitDir = isAbsolute(pointer) ? pointer : resolve(directory, pointer);
      }
      const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
      const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
      if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? `detached@${head}` : null;
      const common = await readFile(join(gitDir, "commondir"), "utf8").then((text) => resolve(gitDir, text.trim())).catch(() => gitDir);
      for (const base of [gitDir, common]) {
        const sha = await readFile(join(base, ref), "utf8").then((text) => text.trim()).catch(() => "");
        if (sha) return `${ref.replace(/^refs\/heads\//, "")}@${sha}`;
      }
      const packed = await readFile(join(common, "packed-refs"), "utf8").catch(() => "");
      const line = packed.split("\n").find((entry) => entry.endsWith(` ${ref}`));
      return line ? `${ref.replace(/^refs\/heads\//, "")}@${line.split(" ")[0]}` : null;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Commit subjects from `from` to `to` (`branch@sha` positions), newest first, bounded in time and size. */
export async function commitSubjects(path: string, from: string, to: string): Promise<string[]> {
  const sha = (position: string) => position.slice(position.lastIndexOf("@") + 1);
  if (!/^[0-9a-f]{40,64}$/.test(sha(from)) || !/^[0-9a-f]{40,64}$/.test(sha(to))) return [];
  const child = Bun.spawn(["/usr/bin/git", "-C", path, "log", "--no-decorate", "--format=%s", "-n", "8", `${sha(from)}..${sha(to)}`], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return [];
    return output.split("\n").map((line) => line.trim().slice(0, 160)).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
