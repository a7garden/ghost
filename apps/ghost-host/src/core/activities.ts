import { isAbsolute, join, resolve, dirname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { ActivityConfig, ActivityAction, matchesToolPatterns, validate, type Activity, type ActivityRun, type ActivitySourceItem, type Connection, type GhostTool, type Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import type { ActivitySourceExclusion, ActivitySourcePoll, ActivitySourcePort } from "../integrations/activity-sources.ts";
import { CommandError, conflict, forbidden, invalid } from "./errors.ts";
import { NoEffect } from "./effects.ts";
import { digestOf, idFor, newId } from "./ids.ts";
import { firstRun } from "./schedules.ts";
import { isTerminal } from "./works.ts";
import { repositoryHead } from "./autonomy.ts";
import { reviseConfiguration } from "./configuration.ts";
import { activityRules } from "./policy.ts";
import { workExecutionIdentity } from "./policy-context.ts";

const DAY = 86_400_000;
const DRY_TOOLS: Partial<Record<GhostTool, true>> = { read: true, web_search: true, web_read: true, skill_read: true, delegate: true, host_status: true, host_services: true, host_disk_scan: true, host_disk_usage: true, host_list: true, host_read: true, host_nodes: true, toss_read: true };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2048);
const FAILURE_PAUSE = "Repeated activity failures";

/** Capacity is a normal, retryable admission outcome, never a source failure. */
export class ActivityDeferred extends CommandError {
  constructor(reason: string, readonly until: number) { super("conflict", reason); this.name = "ActivityDeferred"; }
}

class SourcePollFailure extends CommandError {
  constructor(error: unknown) { super("conflict", message(error)); this.name = "SourcePollFailure"; }
}

interface ActionAuthority {
  activity: Activity;
  run: ActivityRun;
  connection: Connection;
}

/** Admission and standing authority only. Works/Pi remain the sole execution engine. */
export class Activities {
  private stopped = false;

  constructor(private readonly core: Core, private readonly sources: ActivitySourcePort | null) {
    if (!core.ledger.setting("policy:activities:seeded", false)) core.ledger.tx(() => {
      for (const activity of core.ledger.activities()) this.syncPolicy(activity);
      core.ledger.putSetting("policy:activities:seeded", true);
    });
    core.effects.onApproved("activity_propose", async (effect) => {
      const decision = [...core.ledger.decisionsAwaitingFollowUp(), ...core.ledger.pendingDecisions({ effectId: effect.id })].find((entry) => entry.effectId === effect.id);
      const config = decision?.proposal?.config;
      const conversation = core.ledger.conversation(effect.conversationId);
      const ghost = core.ledger.ghost(conversation.ghostId);
      if (conversation.kind !== "direct" || ghost.deletedAt !== null || ghost.state !== "active" || !matchesToolPatterns(ghost.tools, "activity_propose") || !validate(ActivityConfig, config) || (!ghost.isDefault && config.ghostId !== ghost.id)) throw new NoEffect("Activity proposal authority was revoked or the proposal is invalid; nothing was activated.");
      const authority = decision?.proposal?.authority;
      if (typeof authority !== "string" || digestOf({ config, authority }) !== effect.inputDigest) throw new NoEffect("The approved configuration identity changed.");
      try {
        if (this.proposalAuthority(config) !== authority) throw forbidden("The approved source account or Ghost authority changed");
        if (!ghost.isDefault && (!config.scopeId || (this.ledger.scope(config.scopeId).ghostId ?? this.ledger.defaultGhost()?.id) !== ghost.id)) throw forbidden("This Ghost no longer receives the approved scope");
        const activity = this.ledger.tx(() => reviseConfiguration(core, { kind: "ghost", ghostId: ghost.id }, { type: "activity.create", config }, () => this.create(config, idFor(effect.id, "activity")), "Owner-approved standing trigger"));
        return `Activity ${activity.name} (${activity.id}) activated with owner approval.`;
      } catch (error) { throw new NoEffect(message(error)); }
    });
    core.effects.onApproved("activity_action", async (effect) => {
      const decision = [...core.ledger.decisionsAwaitingFollowUp(), ...core.ledger.pendingDecisions({ effectId: effect.id })].find((entry) => entry.effectId === effect.id);
      const proposal = decision?.proposal;
      if (!effect.workId || !proposal || !validate(ActivityAction, proposal.action)) throw new NoEffect("The approved action is missing its bound Work or input.");
      const action = proposal.action;
      let bound: ActionAuthority;
      try {
        bound = this.actionAuthority(effect.workId, action);
        const work = core.ledger.work(effect.workId);
        // Legacy pending approvals carry `workRevision` and keep its stricter check; new ones bind the execution identity and published artifacts.
        const legacy = proposal.workIdentity === undefined;
        const approved = legacy
          ? { workId: proposal.workId, workRevision: proposal.workRevision, runId: proposal.runId, activityRevision: proposal.activityRevision, sourceItem: proposal.sourceItem, action: proposal.action }
          : { workId: proposal.workId, workIdentity: proposal.workIdentity, runId: proposal.runId, activityRevision: proposal.activityRevision, sourceItem: proposal.sourceItem, action: proposal.action };
        if (digestOf(approved) !== effect.inputDigest || (legacy ? proposal.workRevision !== work.revision : proposal.workIdentity !== this.workIdentity(work))) throw forbidden("the approved action input or Work changed");
        if (proposal.runId !== bound.run.id || proposal.activityRevision !== bound.activity.revision || digestOf(proposal.sourceItem) !== digestOf(bound.run.sourceItem)) throw forbidden("the source or approved activity revision changed");
      } catch (error) { throw new NoEffect(message(error)); }
      return (await this.sourcePort().act(bound.connection, bound.run.sourceItem!, action)).summary;
    });
  }

  private get ledger() { return this.core.ledger; }
  stop() { this.stopped = true; }
  private live() { if (this.stopped) throw conflict("activity runtime stopped"); }
  private sourcePort(): ActivitySourcePort {
    if (!this.sources) throw conflict("source connections are unavailable on this Host");
    return this.sources;
  }

  syncPolicy(activity: Activity, previous?: Activity) {
    if (previous && previous.deletedAt === null && previous.scopeId === activity.scopeId && previous.policy.externalActions === activity.policy.externalActions) return;
    const previousRules = new Map(this.ledger.policyRules().map((rule) => [rule.id, rule]));
    if (previous) for (const rule of activityRules(previous)) this.ledger.deletePolicyRule(rule.id);
    for (const rule of activityRules(activity, this.ledger.settings().approvals)) {
      const prior = previousRules.get(rule.id);
      if (!previous && prior) continue;
      this.ledger.putPolicyRule({ ...rule, ...(activity.scopeId ? { scopeId: activity.scopeId } : {}), revision: (prior?.revision ?? 0) + 1 });
    }
  }

  removePolicy(activityId: string) {
    for (const rule of this.ledger.policyRules()) if (rule.triggerId === activityId) this.ledger.deletePolicyRule(rule.id);
  }

  private checkConfig(config: ActivityConfig) {
    if (!validate(ActivityConfig, config)) throw invalid("invalid activity configuration");
    const ghost = this.ledger.ghost(config.ghostId);
    if (ghost.deletedAt !== null || ghost.state !== "active") throw conflict("the activity Ghost is not active");
    if (config.execution.kind === "host" && (!ghost.hostExecution || !isAbsolute(config.execution.cwd))) throw forbidden("unrestricted PC access requires the owner's current Ghost grant and an absolute cwd");
    if (config.scopeId != null) this.ledger.scope(config.scopeId);
    if (config.source.kind === "commit") this.ledger.scope(config.source.scopeId);
    if (config.scopeId) {
      const scope = this.ledger.scope(config.scopeId);
      if (scope.state !== "active" || (scope.ghostId ?? this.ledger.defaultGhost()?.id) !== ghost.id) throw forbidden("activity must run in its receiving Ghost's active scope");
    }
    if (config.source.kind === "commit") {
      if (config.scopeId !== config.source.scopeId) throw forbidden("commit trigger must watch its own scope");
      this.ledger.scope(config.source.scopeId);
    } else if (config.source.kind !== "schedule") {
      const connection = this.ledger.connection(config.source.connectionId);
      if (!connection.hasCredential || !this.sourcePort().credentialPresent(connection.id)) throw conflict("source connection credential is missing or being replaced");
      if (config.source.kind === "mail" && connection.config.kind !== "mail") throw invalid("mail activities need an IMAP mail connection");
      if (config.source.kind === "pull_request" && connection.config.kind !== "github" && connection.config.kind !== "gitea") throw invalid("pull request activities need a GitHub or Gitea connection");
      if (config.source.kind === "poll" && (connection.config.kind !== "api" || !connection.config.ghostIds.includes(ghost.id))) throw forbidden("poll connection is not granted to this Ghost");
    }
  }

  proposalAuthority(config: ActivityConfig): string {
    this.checkConfig(config);
    const ghost = this.ledger.ghost(config.ghostId);
    const connection = "connectionId" in config.source ? this.ledger.connection(config.source.connectionId) : null;
    return digestOf({ ghostId: ghost.id, tools: ghost.tools, hostExecution: ghost.hostExecution, scope: config.scopeId ? this.ledger.scope(config.scopeId) : null, connection: connection ? { id: connection.id, config: connection.config, credentialVersion: connection.credentialVersion, hasCredential: connection.hasCredential } : null });
  }

  private async poll(activity: Activity, baseline: boolean, cursor = activity.cursor) {
    if (activity.source.kind === "schedule") throw invalid("scheduled activities have no source poll");
    if (activity.source.kind === "commit") {
      try { return await this.pollCommits(activity, baseline, cursor); }
      catch (error) { throw new SourcePollFailure(error); }
    }
    const connection = this.ledger.connection(activity.source.connectionId);
    const port = this.sourcePort();
    try { return await port.poll(connection, activity.source, cursor, { baseline }); }
    catch (error) { throw new SourcePollFailure(error); }
  }

  private async pollCommits(activity: Activity, baseline: boolean, encoded: string | null) {
    if (activity.source.kind !== "commit") throw invalid("not a commit trigger");
    const scope = this.ledger.scope(activity.source.scopeId);
    const prior = encoded ? JSON.parse(encoded) as { paths: string[]; positions: Record<string, { last: string; occurrence: number }> } : null;
    if (prior && (!Array.isArray(prior.paths) || !prior.positions || typeof prior.positions !== "object")) throw invalid("Commit cursor is malformed; no cursor advanced.");
    if (prior && digestOf(prior.paths) !== digestOf(scope.paths)) throw conflict("Commit scope paths changed; reset the source baseline.");
    const items: ActivitySourceItem[] = [];
    const positions: Record<string, { last: string; occurrence: number }> = {};
    for (const path of scope.paths) {
      const head = await repositoryHead(path);
      if (!head) {
        if (prior?.positions[path]) throw conflict("A watched repository is unavailable; its commit cursor was retained.");
        continue;
      }
      let directory = resolve(path);
      let gitDir: string | null = null;
      for (;;) {
        const candidate = join(directory, ".git");
        const info = await stat(candidate).catch(() => null);
        if (info?.isDirectory()) { gitDir = candidate; break; }
        if (info?.isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, "utf8"))?.[1]?.trim();
          if (pointer) gitDir = resolve(directory, pointer);
          break;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (!gitDir) continue;
      const logInfo = await stat(join(gitDir, "logs", "HEAD")).catch(() => null);
      if (logInfo && logInfo.size > 8 * 1024 * 1024) throw invalid("Repository HEAD reflog exceeds the scan safety limit; reconcile and rotate it before resetting the baseline.");
      const log = await readFile(join(gitDir, "logs", "HEAD"), "utf8").catch(() => "");
      const entries = log.trim().split("\n").filter(Boolean).map((line) => {
        const match = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) .+ (\d+) [+-]\d{4}\t(.*)$/.exec(line);
        if (!match) throw invalid("Repository reflog is malformed; no commit cursor advanced.");
        return { sha: match[1]!, at: Number(match[2]) * 1000, subject: match[3]!, key: digestOf(line) };
      });
      if (!entries.length) throw invalid("Commit triggers require a repository HEAD reflog; enable Git core.logAllRefUpdates. No cursor advanced.");
      const checkpoint = prior?.positions[path];
      let start = 0;
      if (checkpoint) {
        let occurrence = 0;
        const index = entries.findIndex((entry) => entry.key === checkpoint.last && ++occurrence === checkpoint.occurrence);
        if (index < 0) throw conflict("Repository reflog no longer contains the prior cursor; reconcile missing commits before resetting the baseline.");
        start = index + 1;
      }
      const last = entries.at(-1)!;
      positions[path] = { last: last.key, occurrence: entries.filter((entry) => entry.key === last.key).length };
      for (const entry of entries.slice(start)) {
        const id = digestOf([path, entry.sha]);
        if (!baseline || entry.at >= Math.floor(activity.createdAt / 1000) * 1000) items.push({ id: `commit:${id}`, version: entry.sha, title: entry.subject.slice(0, 512), text: `Repository: ${path}\nCommit: ${entry.sha}\n${entry.subject}`, url: null, author: null, occurredAt: entry.at, target: { kind: "commit", path, sha: entry.sha, scopeId: scope.id } });
      }
    }
    const cursor = JSON.stringify({ paths: scope.paths, positions });
    if (cursor.length > 262144) throw invalid("Commit cursor exceeds its safety limit; no cursor advanced.");
    return { items, exclusions: [], cursor };
  }

  private defer(activity: Activity, deferred: ActivityDeferred) {
    this.ledger.tx(() => this.ledger.putActivity({ ...activity, deferredUntil: deferred.until, deferredReason: deferred.message, updatedAt: Date.now() }));
    this.core.schedules.refresh();
  }

  private pauseForFailures(activity: Activity, failureCount: number, lastError: string, now: number, workId: string | null = null) {
    this.ledger.tx(() => {
      this.ledger.putActivity({ ...activity, failureCount, lastError, paused: true, pauseReason: FAILURE_PAUSE, deferredUntil: null, deferredReason: null, updatedAt: now });
      const ghost = this.ledger.ghost(activity.ghostId);
      this.core.notify({ id: idFor(activity.id, `failure-pause:${activity.revision}`), kind: "message", ghostId: ghost.id, conversationId: ghost.directConversationId, workId, decisionId: null, title: `Activity paused: ${activity.name}`.slice(0, 256), body: `Three repeated failures stopped automatic runs. Review the error and resume when ready. ${lastError}`.slice(0, 2048) });
    });
    this.core.schedules.refresh();
  }

  private sourceFailed(activity: Activity, error: SourcePollFailure, now: number) {
    const failureCount = activity.failureCount + 1;
    if (failureCount >= 3) this.pauseForFailures(activity, failureCount, error.message, now);
    else this.ledger.tx(() => this.ledger.putActivity({ ...activity, failureCount, lastError: error.message, deferredUntil: now + 60_000, deferredReason: null, updatedAt: now }));
    this.core.schedules.refresh();
  }

  private recentFailedRuns(activity: Activity): ActivityRun[] {
    const outcomes = this.ledger.activityRuns(activity.id).filter((run) => run.activityRevision === activity.revision && !run.dryRun && (run.state === "failed" || run.state === "done")).reverse()
      .sort((left, right) => (right.endedAt ?? right.createdAt) - (left.endedAt ?? left.createdAt));
    const failures: ActivityRun[] = [];
    for (const run of outcomes) {
      if (run.state === "done") break;
      failures.push(run);
    }
    return failures;
  }

  /** Includes every pending followup, not a UI history window. */
  nextDueAt(includeSources = true): number | null {
    if (this.stopped) return null;
    let due: number | null = null;
    for (const activity of this.ledger.activities()) {
      const ghost = this.ledger.ghost(activity.ghostId);
      if (activity.paused || ghost.deletedAt !== null || ghost.state !== "active") continue;
      let at = includeSources || activity.source.kind === "schedule" ? activity.nextAt : null;
      for (const run of this.ledger.activityRuns(activity.id)) {
        if (run.state !== "done" || run.dryRun || run.activityRevision !== activity.revision || run.nextCheckAt === null) continue;
        at = at === null ? run.nextCheckAt : Math.min(at, run.nextCheckAt);
      }
      if (at === null) continue;
      at = Math.max(at, activity.deferredUntil ?? 0);
      due = due === null ? at : Math.min(due, at);
    }
    return due;
  }

  create(config: ActivityConfig, id = newId()): Activity {
    const existing = this.ledger.findActivity(id);
    if (existing) {
      const priorConfig = Object.fromEntries(Object.keys(config).map((key) => [key, Reflect.get(existing, key)]));
      if (digestOf(priorConfig) !== digestOf(config)) throw conflict("Activity call identity belongs to different configuration");
      return existing;
    }
    this.live();
    this.checkConfig(config);
    const now = Date.now();
    const activity: Activity = { ...config, scopeId: config.scopeId ?? null, id, revision: 1, paused: false, pauseReason: null, nextAt: config.source.kind === "schedule" ? firstRun(config.source.spec, now) : now, cursor: null, lastCheckedAt: null, lastError: null, failureCount: 0, deletedAt: null, createdAt: now, updatedAt: now };
    this.ledger.tx(() => { this.ledger.putActivity(activity); this.syncPolicy(activity); });
    this.core.schedules.refresh();
    return activity;
  }

  update(id: string, expectedRevision: number, config: ActivityConfig): Activity {
    this.live();
    const previous = this.ledger.activity(id);
    if (previous.deletedAt !== null || previous.revision !== expectedRevision) throw conflict("activity was deleted or changed; refresh before editing");
    if (previous.ghostId !== config.ghostId) throw invalid("an activity cannot change its Ghost");
    this.checkConfig(config);
    const changedSource = digestOf(previous.source) !== digestOf(config.source);
    const now = Date.now();
    const activity: Activity = { ...previous, ...config, scopeId: config.scopeId ?? null, revision: previous.revision + 1, cursor: changedSource ? null : previous.cursor, nextAt: changedSource ? (config.source.kind === "schedule" ? firstRun(config.source.spec, now) : now) : previous.nextAt, lastError: null, failureCount: 0, deferredUntil: null, deferredReason: null, updatedAt: now };
    this.ledger.tx(() => {
      this.ledger.putActivity(activity);
      this.syncPolicy(activity, previous);
      this.cancelRuns(id, "activity configuration changed by owner");
    });
    this.core.schedules.refresh();
    return activity;
  }

  pause(id: string, paused: boolean, cancelRunning = false): Activity {
    const activity = this.ledger.activity(id);
    if (activity.deletedAt !== null) throw conflict("activity was deleted");
    const recovering = !paused && activity.pauseReason === FAILURE_PAUSE;
    const next = { ...activity, paused, pauseReason: paused ? (activity.pauseReason === FAILURE_PAUSE ? FAILURE_PAUSE : "paused by owner") : null, ...(recovering ? { revision: activity.revision + 1, failureCount: 0, lastError: null } : {}), deferredUntil: null, deferredReason: null, updatedAt: Date.now() };
    this.ledger.tx(() => {
      this.ledger.putActivity(next);
      if (cancelRunning) this.cancelRuns(id, "activity stopped by owner");
    });
    this.core.schedules.refresh();
    return next;
  }

  delete(id: string) {
    const activity = this.ledger.activity(id);
    this.ledger.tx(() => {
      this.ledger.putActivity({ ...activity, paused: true, deletedAt: Date.now(), revision: activity.revision + 1, updatedAt: Date.now() });
      this.removePolicy(id);
      this.cancelRuns(id, "activity deleted by owner");
    });
    this.core.schedules.refresh();
  }

  private cancelRuns(id: string, reason: string) {
    const cancelTree = (work: Work) => {
      for (const child of this.ledger.children(work.id)) cancelTree(child);
      if (!isTerminal(work)) this.core.works.cancel(work.id, reason);
    };
    for (const run of this.ledger.activityRuns(id)) if (run.workId) cancelTree(this.ledger.work(run.workId));
  }

  /** Called inside the same transaction that replaces/revokes account authority. */
  invalidateConnection(connectionId: string) {
    for (const activity of this.ledger.activities()) {
      if (activity.source.kind !== "schedule" && activity.source.kind !== "commit" && activity.source.connectionId === connectionId) {
        this.cancelRuns(activity.id, "source account configuration or credential changed");
        this.ledger.putActivity({ ...activity, cursor: null, nextAt: Date.now(), updatedAt: Date.now() });
        this.ledger.putSetting(`activity:inbox:${activity.id}`, null);
      }
    }
  }

  private current(id: string, revision?: number, allowPaused = false): Activity {
    this.live();
    const activity = this.ledger.activity(id);
    if (activity.deletedAt !== null || (!allowPaused && activity.paused)) throw forbidden("activity is paused or deleted");
    if (revision !== undefined && activity.revision !== revision) throw forbidden("activity authority changed; this run has a stale revision");
    this.checkConfig(activity);
    return activity;
  }

  private sourceKey(activity: Activity, item: Pick<ActivitySourceItem, "id" | "version">): string {
    const source = activity.source;
    const connection = source.kind === "schedule" || source.kind === "commit" ? null : this.ledger.connection(source.connectionId);
    return `source:${digestOf([source, connection?.id, connection?.credentialVersion, connection?.config, item.id, source.kind === "poll" ? null : item.version])}`;
  }

  private capacity(activity: Activity, now: number): string | null {
    const runs = this.ledger.activityRuns(activity.id).filter((run) => run.workId !== null);
    const active = runs.filter((run) => this.treeActive(this.ledger.work(run.workId!)));
    if (active.length >= activity.policy.maxConcurrent) return "max concurrent runs reached; source item retained for a later tick";
    if (runs.filter((run) => !run.dryRun && run.createdAt > now - DAY).length >= activity.policy.maxRunsPerDay) return "daily run budget reached; source item retained for a later tick";
    return null;
  }

  private treeActive(work: Work): boolean {
    return !isTerminal(work) || this.ledger.children(work.id).some((child) => this.treeActive(child));
  }

  private workItems(work: Work): number {
    let count = 1;
    for (const child of this.ledger.children(work.id)) count += this.workItems(child);
    return count;
  }


  private admit(activity: Activity, input: { key: string; trigger: ActivityRun["trigger"]; item?: ActivitySourceItem | null; dryRun?: boolean; followupOf?: string | null; reason?: string | null }, now: number): ActivityRun {
    const id = idFor(activity.id, input.key);
    const existing = this.ledger.findActivityRun(id);
    if (existing) return existing;
    activity = this.current(activity.id, activity.revision, input.trigger === "manual" || input.trigger === "dry_run");
    const limit = this.capacity(activity, now);
    if (limit) throw new ActivityDeferred(limit, now + 30_000);
    const ghost = this.ledger.ghost(activity.ghostId);
    const settings = this.ledger.settings();
    const model = settings.reviewModel ?? ghost.model ?? settings.defaultModel;
    if (!model) throw conflict("configure an assignee/default or review model before running this activity");
    const dryRun = input.dryRun === true;
    return this.ledger.tx(() => {
      const run: ActivityRun = { id, activityId: activity.id, workId: null, trigger: input.trigger, sourceKey: input.key, sourceItem: input.item ?? null, state: "queued", activityRevision: activity.revision, reason: input.reason ?? null, dryRun, noChange: false, createdAt: now, endedAt: null, nextCheckAt: null, nextCheckReason: null, followupOf: input.followupOf ?? null };
      // Persist run+Work together before kick's afterCommit work can open a conversation.
      this.ledger.putActivityRun(run);
      const work = this.core.works.createRoot({ id: idFor(id, "work"), ghostId: ghost.id, scopeId: activity.scopeId, title: activity.name, brief: activity.prompt, acceptance: { criteria: activity.acceptanceCriteria, checks: [], reviewer: { kind: "model", model } }, originConversationId: ghost.directConversationId, deadlineAt: now + activity.policy.runTimeoutSeconds * 1000, execution: activity.execution, activityId: activity.id, activityRunId: id, toolScope: dryRun ? Object.keys(DRY_TOOLS).filter((tool) => matchesToolPatterns(activity.tools, tool) && matchesToolPatterns(ghost.tools, tool)) : activity.tools });
      const next = { ...run, workId: work.id };
      this.ledger.putActivityRun(next);
      return next;
    });
  }

  run(id: string, options: { dryRun?: boolean; requestId?: string } = {}): Promise<{ runIds: string[] }> {
    const lane = this.ledger.activity(id).source.kind === "schedule" ? "activities:timers" : "activities:tick";
    return this.core.run(lane, async () => {
      const claim = options.requestId ? this.ledger.request(options.requestId) : null;
      if (options.requestId && !claim) throw invalid("activity run request has no standard API admission receipt");
      if (claim?.state === "done") {
        const runIds = claim.outcome.runIds;
        if (!Array.isArray(runIds) || runIds.some((runId) => typeof runId !== "string" || this.ledger.findActivityRun(runId)?.activityId !== id)) throw conflict("request receipt does not belong to this activity run");
        return { runIds: runIds as string[] };
      }
      let activity = this.current(id, undefined, true);
      const key = `${options.dryRun ? "dry" : "manual"}:${options.requestId ?? newId()}`;
      let item: ActivitySourceItem | null = null;
      let exclusions: ActivitySourceExclusion[] = [];
      const limit = this.capacity(activity, Date.now());
      if (limit) {
        const deferred = new ActivityDeferred(limit, Date.now() + 30_000);
        if (!options.dryRun) this.defer(activity, deferred);
        throw deferred;
      }
      if (activity.source.kind !== "schedule") {
        let polled;
        try { polled = await this.poll(activity, false, options.dryRun ? null : activity.cursor); }
        catch (error) {
          const current = this.ledger.activity(id);
          if (error instanceof SourcePollFailure && !options.dryRun && !current.paused && current.revision === activity.revision && !this.stopped) this.sourceFailed(current, error, Date.now());
          throw error;
        }
        activity = this.current(id, activity.revision, true);
        item = polled.items[0] ?? null;
        exclusions = polled.exclusions;
      }
      return this.ledger.tx(() => {
        const excluded = options.dryRun ? [] : exclusions.map((entry) => this.exclude(activity, entry));
        const run = activity.source.kind !== "schedule" && !item
          ? (excluded[0] ?? this.skipped(activity, key, options.dryRun ? "dry_run" : "manual", exclusions[0]?.reason ?? "No matching source item; no model was started."))
          : this.admit(activity, { key: item && !options.dryRun ? this.sourceKey(activity, item) : key, trigger: options.dryRun ? "dry_run" : "manual", item, dryRun: options.dryRun }, Date.now());
        const outcome = { runIds: [...new Set([run.id, ...excluded.map((entry) => entry.id)])] };
        if (options.requestId && claim) this.ledger.putRequest(options.requestId, claim.principal, claim.digest, outcome);
        return outcome;
      });
    });
  }

  private skipped(activity: Activity, key: string, trigger: ActivityRun["trigger"], reason: string, noChange = true): ActivityRun {
    const now = Date.now();
    const run: ActivityRun = { id: idFor(activity.id, key), activityId: activity.id, workId: null, trigger, sourceKey: key, sourceItem: null, state: "skipped", activityRevision: activity.revision, reason, dryRun: trigger === "dry_run", noChange, createdAt: now, endedAt: now, nextCheckAt: null, nextCheckReason: null, followupOf: null };
    this.ledger.tx(() => this.ledger.putActivityRun(run));
    return run;
  }

  private exclude(activity: Activity, exclusion: ActivitySourceExclusion): ActivityRun {
    const key = this.sourceKey(activity, { id: exclusion.id, version: "excluded:mail-size-limit" });
    const existing = this.ledger.findActivityRun(idFor(activity.id, key));
    if (existing) return existing;
    return this.ledger.tx(() => {
      const run = this.skipped(activity, key, "source", exclusion.reason.slice(0, 2048), false);
      const ghost = this.ledger.ghost(activity.ghostId);
      this.core.notify({ id: idFor(run.id, "source-excluded"), kind: "message", ghostId: ghost.id, conversationId: ghost.directConversationId, workId: null, decisionId: null, title: `Activity source needs attention: ${activity.name}`.slice(0, 256), body: `${exclusion.reason}\nSource ID: ${exclusion.id}`.slice(0, 2048) });
      return run;
    });
  }

  async tickTimers(now = Date.now()) {
    return this.core.run("activities:timers", async () => {
      if (this.stopped) return;
      now = Math.max(now, Date.now());
      for (const snapshot of this.ledger.activities()) {
        if (this.stopped) return;
        if (snapshot.paused || (snapshot.deferredUntil ?? 0) > now) continue;
        try {
          const activity = this.current(snapshot.id, snapshot.revision);
          const failed = this.recentFailedRuns(activity);
          if (failed.length >= 3) {
            this.pauseForFailures(activity, failed.length, failed[0]!.reason ?? "Activity Work failed", now, failed[0]!.workId);
            continue;
          }
          for (const run of this.ledger.activityRuns(activity.id)) {
            if (run.nextCheckAt === null || run.nextCheckAt > now || !run.workId || !isTerminal(this.ledger.work(run.workId))) continue;
            if (run.activityRevision !== activity.revision || run.state !== "done" || run.dryRun) continue;
            this.admit(activity, { key: `check:${run.id}:${run.nextCheckAt}`, trigger: "self_check", item: run.sourceItem, followupOf: run.id, reason: run.nextCheckReason }, now);
            this.ledger.tx(() => this.ledger.putActivityRun({ ...run, nextCheckAt: null, nextCheckReason: null }));
          }
          if (activity.source.kind === "schedule" && activity.nextAt !== null && activity.nextAt <= now) {
            const at = activity.nextAt;
            this.admit(activity, { key: `schedule:${at}`, trigger: "schedule" }, now);
            const nextAt = activity.source.spec.kind === "every" ? firstRun(activity.source.spec, Math.max(now, at) + 1) : null;
            this.ledger.tx(() => this.ledger.putActivity({ ...activity, nextAt, lastCheckedAt: now, lastError: null, failureCount: 0, deferredUntil: null, deferredReason: null, updatedAt: now }));
          }
        } catch (error) {
          const activity = this.ledger.activity(snapshot.id);
          if (activity.revision !== snapshot.revision || activity.paused || this.stopped) continue;
          if (error instanceof ActivityDeferred) this.defer(activity, error);
          else this.ledger.tx(() => this.ledger.putActivity({ ...activity, lastError: message(error), deferredUntil: now + 60_000, deferredReason: null, updatedAt: now }));
        }
      }
    });
  }

  async tickSources(now = Date.now()) {
    return this.core.run("activities:tick", async () => {
      if (this.stopped) return;
      now = Math.max(now, Date.now());
      for (const snapshot of this.ledger.activities()) {
        if (this.stopped) return;
        if (snapshot.source.kind === "schedule" || snapshot.paused || (snapshot.deferredUntil ?? 0) > now) continue;
        try {
          let activity = this.current(snapshot.id, snapshot.revision);
          if (activity.source.kind === "schedule") continue;
          const failed = this.recentFailedRuns(activity);
          if (failed.length >= 3) {
            this.pauseForFailures(activity, failed.length, failed[0]!.reason ?? "Activity Work failed", now, failed[0]!.workId);
            continue;
          }
          if (activity.nextAt === null || activity.nextAt <= now) {
            const limit = this.capacity(activity, now);
            if (limit) throw new ActivityDeferred(limit, now + 30_000);
            const pollSeconds = "pollSeconds" in activity.source ? activity.source.pollSeconds : 60;
            const inboxKey = `activity:inbox:${activity.id}`;
            const connection = activity.source.kind === "commit" ? null : this.ledger.connection(activity.source.connectionId);
            const authority = digestOf([activity.source, activity.ghostId, activity.scopeId, activity.source.kind === "commit" ? this.ledger.scope(activity.source.scopeId).paths : [connection?.id, connection?.config, connection?.credentialVersion, connection?.hasCredential]]);
            const saved = this.ledger.setting<{ authority: string; result: ActivitySourcePoll } | null>(inboxKey, null);
            const result = saved?.authority === authority ? saved.result : await this.poll(activity, activity.cursor === null && ("includeExisting" in activity.source ? !activity.source.includeExisting : activity.source.kind === "commit"));
            this.ledger.tx(() => this.ledger.putSetting(inboxKey, { authority, result }));
            activity = this.current(activity.id, activity.revision);
            const admittedAt = Math.max(now, Date.now());
            // The durable inbox retains the complete polled batch across capacity waits,
            // pauses and crashes, even if the provider's next response no longer contains it.
            for (const exclusion of result.exclusions) this.exclude(activity, exclusion);
            for (const item of result.items) this.admit(activity, { key: this.sourceKey(activity, item), trigger: "source", item }, admittedAt);
            if ((activity.source.kind === "poll" || activity.source.kind === "commit") && result.items.length === 0 && result.exclusions.length === 0) this.skipped(activity, `empty:${activity.revision}:${activity.nextAt ?? now}`, "source", "Source returned no new items; no model was started.");
            const next = { ...activity, cursor: result.cursor, nextAt: admittedAt + pollSeconds * 1000, lastCheckedAt: admittedAt, lastError: null, failureCount: 0, deferredUntil: null, deferredReason: null, updatedAt: admittedAt };
            this.ledger.tx(() => { this.ledger.putActivity(next); this.ledger.putSetting(inboxKey, null); });
          }
        } catch (error) {
          const activity = this.ledger.activity(snapshot.id);
          if (activity.revision !== snapshot.revision || activity.paused || this.stopped) continue;
          if (error instanceof ActivityDeferred) this.defer(activity, error);
          else if (error instanceof SourcePollFailure) this.sourceFailed(activity, error, now);
          else this.ledger.tx(() => this.ledger.putActivity({ ...activity, lastError: message(error), deferredUntil: now + 60_000, deferredReason: null, updatedAt: now }));
        }
      }
    });
  }

  authorize(workId: string, toolName?: string): { activity: Activity; run: ActivityRun; work: Work } {
    const work = this.ledger.work(workId);
    if (!work.activityId || !work.activityRunId) throw forbidden("this Work is not bound to an approved activity");
    const run = this.ledger.findActivityRun(work.activityRunId);
    if (!run || run.activityId !== work.activityId || run.workId !== work.rootId) throw forbidden("activity run lineage is invalid");
    const root = this.ledger.work(work.rootId);
    if (isTerminal(root) || isTerminal(work) || root.state === "blocked" || work.state === "blocked") throw forbidden("activity Work is settled, cancelled, or blocked");
    if ((root.deadlineAt !== null && root.deadlineAt <= Date.now()) || (work.deadlineAt !== null && work.deadlineAt <= Date.now())) throw forbidden("activity run timeout reached");
    const activity = this.current(work.activityId, run.activityRevision, true);
    const ghost = this.ledger.ghost(work.ghostId);
    if (ghost.deletedAt !== null || ghost.state !== "active") throw forbidden("the executing Ghost is no longer active");
    if (work.execution?.kind === "host" && !ghost.hostExecution) throw forbidden("unrestricted PC execution grant was revoked");
    if (toolName && !toolName.startsWith("activity_") && toolName !== "complete" && toolName !== "ask_owner" && toolName !== "ask_parent" && toolName !== "ask_peer" && toolName !== "answer_question" && toolName !== "work_status") {
      const tool = toolName as GhostTool;
      if (!matchesToolPatterns(activity.tools, tool) || !matchesToolPatterns(ghost.tools, tool) || !work.toolScope || !matchesToolPatterns(work.toolScope, tool)) throw forbidden(`${toolName} is outside this activity's current scope`);
      if (run.dryRun && !DRY_TOOLS[tool]) throw forbidden(`${toolName} is disabled in dry runs`);
      const activityNodes = this.core.ledger.limits(activity.scopeId).activityNodes;
      if (tool === "delegate" && this.workItems(root) >= activityNodes) throw conflict(`activity run is limited to ${activityNodes} Work items including descendants`);
    }
    return { activity, run, work };
  }

  requestNextCheck(workId: string, at: number, reason: string, requestedAt = Date.now()): ActivityRun {
    const { activity, run, work } = this.authorize(workId, "activity_next_check");
    if (work.parentId) throw forbidden("only the root run can request its next check");
    if (activity.paused || !activity.policy.allowSelfCheck || run.dryRun) throw forbidden("self checks are disabled or paused for this run");
    if (run.nextCheckAt === at && run.nextCheckReason === reason) return run;
    if (!Number.isSafeInteger(at) || at < requestedAt + activity.policy.minCheckSeconds * 1000 || at > requestedAt + 30 * DAY) throw invalid("next check must respect the minimum interval and be within 30 days");
    if (!reason.trim() || reason.length > 2048) throw invalid("next check needs a bounded reason");
    const next = { ...run, nextCheckAt: at, nextCheckReason: reason };
    this.ledger.tx(() => this.ledger.putActivityRun(next));
    this.core.schedules.refresh();
    return next;
  }

  async read(workId: string): Promise<ActivitySourceItem> {
    const { activity, run } = this.authorize(workId, "activity_read");
    if (activity.source.kind === "schedule" || !run.sourceItem) throw forbidden("this run has no bound source item");
    if (activity.source.kind === "commit") return run.sourceItem;
    const item = await this.sourcePort().read(this.ledger.connection(activity.source.connectionId), run.sourceItem);
    this.authorize(workId, "activity_read");
    return item;
  }

  private actionAuthority(workId: string, action: ActivityAction): ActionAuthority {
    if (!validate(ActivityAction, action)) throw invalid("invalid source action");
    const { activity, run } = this.authorize(workId, "activity_action");
    if (run.dryRun) throw forbidden("external actions are disabled in dry runs");
    if (activity.source.kind === "schedule" || activity.source.kind === "commit" || activity.source.kind === "poll" || !run.sourceItem) throw forbidden("this run has no bound source action target");
    if ((action.kind === "mail_reply") !== (activity.source.kind === "mail")) throw forbidden("action does not match this run's source");
    const connection = this.ledger.connection(activity.source.connectionId);
    let origin: ActivityRun = run;
    const lineage = new Set<string>();
    while (origin.followupOf) {
      if (lineage.has(origin.id)) throw forbidden("source run lineage is invalid");
      lineage.add(origin.id);
      const parent: ActivityRun | null = this.ledger.findActivityRun(origin.followupOf);
      if (!parent || parent.activityId !== activity.id) throw forbidden("source run lineage is invalid");
      origin = parent;
    }
    if (!origin.sourceItem || origin.sourceKey !== this.sourceKey(activity, origin.sourceItem)) throw forbidden("the bound source account or credential authority changed");
    if (action.kind === "mail_reply") {
      if (!run.sourceItem.target.replyTo) throw forbidden("this source email has no safe reply mailbox");
      if (connection.config.kind !== "mail" || !connection.config.smtpHost) throw forbidden("mail replies require configured SMTP; read-only triage is still available");
    }
    return { activity, run, connection };
  }

  private workIdentity(work: Work): string {
    return digestOf({ execution: workExecutionIdentity(this.ledger, work), artifacts: this.ledger.artifactsForWork(work.id).map((artifact) => artifact.digest).sort() });
  }

  async action(workId: string, callId: string, action: ActivityAction): Promise<string> {
    const bound = this.actionAuthority(workId, action);
    const work = this.ledger.work(workId);
    if (!work.conversationId) throw conflict("the Work has no conversation");
    const input = { workId, workIdentity: this.workIdentity(work), runId: bound.run.id, activityRevision: bound.activity.revision, sourceItem: bound.run.sourceItem, action };
    const effect = { conversationId: work.conversationId, callId, tool: "activity_action", input, summary: `${action.kind}: ${bound.run.sourceItem!.title}` };
    const item = bound.run.sourceItem!;
    let destination = item.target.replyTo ?? "";
    let account: string;
    if (bound.connection.config.kind === "mail") account = `${bound.connection.name} (${bound.connection.config.username})`;
    else {
      account = `${bound.connection.name} (${bound.connection.config.baseUrl})`;
      destination = `${item.target.repository ?? ""}#${item.target.number ?? ""}`;
      if (item.url) {
        try {
          const url = new URL(item.url);
          if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) destination += `\nURL: ${url.href}`;
        } catch { /* Invalid provider URLs are not approval destinations. */ }
      }
    }
    const verb = action.kind === "mail_reply" ? "메일 답장 보내기" : "PR 댓글 달기";
    const proposal = this.core.effects.propose({ ...effect,
      classification: { target: { kind: action.kind === "mail_reply" ? "mail_account" : "connection", id: bound.connection.id }, access: "write", reversible: false, external: true, amount: null },
      title: `${verb}: ${item.title}`.slice(0, 200), detail: `- 보내는 계정: ${account}\n- 받는 곳: ${destination.replace("\nURL: ", " · ")}\n- 원본: ${item.title}\n\n**보낼 본문**\n\n${action.body}`, proposal: input });
    const policy = this.ledger.setting<{ evaluation: { decision: string } } | null>(`policy:effect:${proposal.id}`, null);
    if (policy?.evaluation.decision === "allow") {
      await this.core.effects.resolveApproval(proposal.id, true);
      const settled = this.ledger.effect(proposal.id);
      if (settled.state === "unknown") throw conflict(settled.result ?? "The external action outcome is unknown; reconcile it before retrying.");
      if (settled.state === "denied") throw forbidden(settled.result ?? "The action was denied before it ran.");
      if (settled.state === "done" && settled.result !== null) return settled.result;
    }
    return this.core.effects.proposalStatus(proposal);
  }

  context(work: Work): string {
    if (!work.activityId || !work.activityRunId) return "";
    const activity = this.ledger.activity(work.activityId);
    const run = this.ledger.findActivityRun(work.activityRunId);
    if (!run) return "";
    const sourceItem = run.sourceItem ? { id: run.sourceItem.id, version: run.sourceItem.version, title: run.sourceItem.title.slice(0, 512), text: run.sourceItem.text.slice(0, 16_384), url: run.sourceItem.url, author: run.sourceItem.author, occurredAt: run.sourceItem.occurredAt } : null;
    const payload = JSON.stringify({ activity: { id: activity.id, name: activity.name, revision: run.activityRevision }, trigger: run.trigger, followupReason: run.reason?.slice(0, 2048) ?? null, dryRun: run.dryRun, externalActions: activity.policy.externalActions, selfCheck: { allowed: activity.policy.allowSelfCheck && !activity.paused, minSeconds: activity.policy.minCheckSeconds }, sourceItem });
    return payload.length > 32_768 ? `${payload.slice(0, 32_730)}\n[activity context truncated]` : payload;
  }

  settled(work: Work): { notify: boolean } {
    const run = work.activityRunId ? this.ledger.findActivityRun(work.activityRunId) : null;
    const activity = work.activityId ? this.ledger.findActivity(work.activityId) : null;
    if (!run || !activity || work.parentId || !isTerminal(work)) return { notify: true };
    const next = { ...run, state: work.state, endedAt: work.endedAt, noChange: work.result?.noChange === true && !this.ledger.hasWorkTreeMutations(work.id), ...(work.state === "done" ? {} : { nextCheckAt: null, nextCheckReason: null }) };
    this.ledger.tx(() => this.ledger.putActivityRun(next));
    if (!activity.paused && activity.deletedAt === null && run.activityRevision === activity.revision && !run.dryRun && (work.state === "failed" || work.state === "done")) {
      const failed = this.recentFailedRuns(activity);
      if (failed.length >= 3) this.pauseForFailures(activity, failed.length, failed[0]!.reason ?? "Activity Work failed", Date.now(), failed[0]!.workId);
      else if (failed.length > 0) this.ledger.tx(() => this.ledger.putActivity({ ...activity, failureCount: Math.max(activity.failureCount, failed.length), lastError: failed[0]!.reason ?? "Activity Work failed", updatedAt: Date.now() }));
      else if (work.state === "done" && (work.endedAt ?? 0) >= activity.updatedAt) this.ledger.tx(() => this.ledger.putActivity({ ...activity, failureCount: 0, lastError: null, updatedAt: Date.now() }));
    }
    this.core.schedules.refresh();
    return { notify: work.state !== "done" || !next.noChange || activity.policy.delivery === "always" };
  }
}
