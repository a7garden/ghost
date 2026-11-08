import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ActivityConfig, Command, CommandRequest, ConnectionConfig } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import { SourceConnections } from "../src/integrations/activity-sources.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox, tempDir } from "./support.ts";

const context = { publicOrigin: "http://localhost", documents: null };
const github: ConnectionConfig = { kind: "github", baseUrl: "https://api.github.com" };
const request = (command: Command): CommandRequest => ({ requestId: crypto.randomUUID(), command });

function fixture() {
  const root = tempDir();
  const ledger = new Ledger(join(root, "ledger.sqlite"));
  const calls: { url: string; authorization: string | null }[] = [];
  const sources = new SourceConnections({
    root, currentConnection: (id) => ledger.findConnection(id),
    fetch: (async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
      return Response.json({ id: 1, login: "owner" });
    }) as typeof fetch,
  });
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), activitySources: sources, log: () => {} });
  core.attach(new FakeEngine());
  const ghost = core.createGhost({ name: "Owner", persona: "", model: { provider: "test", model: "test" } });
  const owner = new Access(ledger, { kind: "owner" });
  const send = (command: Command) => execute(core, owner, request(command), context);
  const config: ActivityConfig = {
    ghostId: ghost.id, name: "Watch", prompt: "Check for changes", acceptanceCriteria: "Report meaningful changes",
    source: { kind: "schedule", spec: { kind: "every", seconds: 3600, startAt: Date.now() + 3_600_000 } },
    execution: { kind: "container" }, tools: [],
    policy: { maxRunsPerDay: 10, maxConcurrent: 2, runTimeoutSeconds: 300, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
  };
  return {
    root, ledger, core, sources, calls, ghost, owner, send, config,
    async close() { await core.idle(); core.stop(); await sources.close(); ledger.close(); },
  };
}

function rejectSuccess(ledger: Ledger, requestId: string) {
  ledger.db.exec(`CREATE TRIGGER reject_autonomy_receipt BEFORE INSERT ON requests WHEN NEW.id = '${requestId}' AND NEW.state = 'done' BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;`);
}

describe("owner autonomy commands", () => {
  test("account rotation, reconfiguration, credential removal and deletion cancel before secret IO; rename retains live authority", async () => {
    for (const change of ["rotate", "config", "remove", "delete"] as const) {
      const f = fixture();
      try {
        const created = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "old-token" });
        const id = created.connectionId as string;
        f.sources.poll = async () => ({ items: [{ id: "pr:bound:1", version: "1", title: "Review", text: "Metadata", author: null, url: null, occurredAt: null, target: {} }], exclusions: [], cursor: "bound-cursor" });
        const activity = f.core.activities.create({ ...f.config, source: { kind: "pull_request", connectionId: id, repository: "owner/repo", baseBranch: null, labels: [], includeDrafts: false, includeExisting: true, pollSeconds: 60 } });
        await f.core.activities.tickSources(Date.now());
        await f.core.idle();
        const run = f.ledger.activityRuns(activity.id)[0]!;
        const before = f.ledger.activity(activity.id);
        await f.send({ type: "connection.upsert", connectionId: id, name: "Renamed", config: github });
        expect(f.ledger.activity(activity.id)).toEqual(before);
        expect(f.core.activities.authorize(run.workId!).run.id).toBe(run.id);
        const set = f.sources.setCredential.bind(f.sources);
        let checked = false;
        f.sources.setCredential = async (connectionId, value, version) => {
          checked = true;
          expect(f.ledger.connection(id).hasCredential).toBe(false);
          expect(f.ledger.activity(activity.id).cursor).toBeNull();
          expect(f.ledger.work(run.workId!).state).toBe("cancelled");
          expect(() => f.core.activities.authorize(run.workId!)).toThrow("cancelled");
          await set(connectionId, value, version);
        };
        await f.send(change === "delete" ? { type: "connection.delete", connectionId: id } : {
          type: "connection.upsert", connectionId: id, name: "Changed", config: change === "config" ? { kind: "github", baseUrl: "https://new.example/api" } : github, credential: change === "remove" ? null : "new-token",
        });
        expect(checked).toBe(true);
        expect(f.ledger.work(run.workId!).state).toBe("cancelled");
      } finally { await f.close(); }
    }
  });

  test("failed account cancellation rolls back authority invalidation before secret IO", async () => {
    const f = fixture();
    try {
      const created = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "old-token" });
      const id = created.connectionId as string;
      f.sources.poll = async () => ({ items: [{ id: "pr:bound:1", version: "1", title: "Review", text: "Metadata", author: null, url: null, occurredAt: null, target: {} }], exclusions: [], cursor: "bound-cursor" });
      const activity = f.core.activities.create({ ...f.config, source: { kind: "pull_request", connectionId: id, repository: "owner/repo", baseBranch: null, labels: [], includeDrafts: false, includeExisting: true, pollSeconds: 60 } });
      await f.core.activities.tickSources(Date.now());
      await f.core.idle();
      const work = f.ledger.work(f.ledger.activityRuns(activity.id)[0]!.workId!);
      const beforeConnection = f.ledger.connection(id);
      const beforeActivity = f.ledger.activity(activity.id);
      f.ledger.db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON works WHEN NEW.state = 'cancelled' BEGIN SELECT RAISE(ABORT, 'cancel fault'); END;");
      let writes = 0;
      f.sources.setCredential = async () => { writes++; };
      await expect(f.send({ type: "connection.upsert", connectionId: id, name: "Rotate", config: github, credential: "new-token" })).rejects.toThrow("cancel fault");
      expect(writes).toBe(0);
      expect(f.ledger.connection(id)).toEqual(beforeConnection);
      expect(f.ledger.activity(activity.id)).toEqual(beforeActivity);
      expect(f.ledger.work(work.id)).toEqual(work);
      f.ledger.db.exec("DROP TRIGGER reject_cancel");
    } finally { await f.close(); }
  });

  test("PC execution defaults off, owner grants round-trip, and work targets are forwarded", async () => {
    const f = fixture();
    try {
      expect(f.ledger.ghost(f.ghost.id).hostExecution).toBe(false);
      await expect(f.send({ type: "work.create", ghostId: f.ghost.id, title: "PC", brief: "Read", execution: { kind: "host", cwd: f.root } })).rejects.toThrow("not granted");
      const created = await f.send({ type: "ghost.create", name: "PC", persona: "", hostExecution: true });
      expect(f.ledger.ghost(created.ghostId as string).hostExecution).toBe(true);
      await f.send({ type: "ghost.update", ghostId: f.ghost.id, hostExecution: true });
      await f.send({ type: "ghost.update", ghostId: f.ghost.id, name: "Renamed" });
      expect(f.ledger.ghost(f.ghost.id).hostExecution).toBe(true);
      const work = await f.send({ type: "work.create", ghostId: f.ghost.id, title: "PC", brief: "Read", execution: { kind: "host", cwd: f.root } });
      expect(f.ledger.work(work.workId as string).execution).toEqual({ kind: "host", cwd: f.root });
      await f.send({ type: "ghost.update", ghostId: f.ghost.id, hostExecution: false });
      expect(f.ledger.ghost(f.ghost.id).hostExecution).toBe(false);
    } finally { await f.close(); }
  });

  test("paired devices cannot grant PC execution or manage activities/accounts", async () => {
    const f = fixture();
    try {
      const device = new Access(f.ledger, { kind: "device", deviceId: "phone", name: "Phone", grants: [{ ghostId: f.ghost.id, conversationId: null }] });
      const commands: Command[] = [
        { type: "ghost.create", name: "PC", persona: "", hostExecution: true },
        { type: "ghost.update", ghostId: f.ghost.id, hostExecution: true },
        { type: "connection.upsert", name: "Account", config: github, credential: "secret" },
        { type: "connection.delete", connectionId: "account" }, { type: "connection.test", connectionId: "account" },
        { type: "activity.create", config: f.config },
        { type: "activity.update", activityId: "activity", expectedRevision: 1, config: f.config },
        { type: "activity.pause", activityId: "activity", paused: true },
        { type: "activity.delete", activityId: "activity" }, { type: "activity.run", activityId: "activity" },
        { type: "activity.stop_all", ghostId: f.ghost.id },
      ];
      for (const command of commands) {
        const req = request(command);
        await expect(execute(f.core, device, req, context)).rejects.toThrow("needs the owner");
        expect(f.ledger.request(req.requestId)).toBeNull();
      }
      expect(f.ledger.connections()).toHaveLength(0);
      expect(f.ledger.activities()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("activity edits, run admission, stop-all and deletion replay stable receipts", async () => {
    const f = fixture();
    try {
      const req = request({ type: "activity.create", config: f.config });
      const created = await execute(f.core, f.owner, req, context);
      expect(await execute(f.core, f.owner, req, context)).toEqual(created);
      const id = created.activityId as string;
      expect(f.ledger.activities()).toHaveLength(1);
      const edit = request({ type: "activity.update", activityId: id, expectedRevision: 1, config: { ...f.config, name: "Edited" } });
      await execute(f.core, f.owner, edit, context);
      await execute(f.core, f.owner, edit, context);
      expect(f.ledger.activity(id)).toMatchObject({ name: "Edited", revision: 2 });
      await expect(f.send({ type: "activity.update", activityId: id, expectedRevision: 1, config: f.config })).rejects.toThrow("changed");
      await f.send({ type: "activity.pause", activityId: id, paused: true });
      await f.send({ type: "activity.pause", activityId: id, paused: false });
      const run = request({ type: "activity.run", activityId: id, dryRun: true });
      const [first, retry] = await Promise.all([execute(f.core, f.owner, run, context), execute(f.core, f.owner, run, context)]);
      expect(retry).toEqual(first);
      expect(f.ledger.activityRuns(id)).toHaveLength(1);
      expect(f.ledger.activityRuns(id)[0]).toMatchObject({ dryRun: true, trigger: "dry_run" });
      expect(f.ledger.request(run.requestId)).toMatchObject({ state: "done", outcome: first });
      expect(f.ledger.effectsInState("done").some((effect) => effect.callId === `api:${run.requestId}`)).toBe(false);
      await f.core.idle();
      const otherGhost = f.core.createGhost({ name: "Other", persona: "" });
      const other = await f.send({ type: "activity.create", config: { ...f.config, ghostId: otherGhost.id } });
      await f.send({ type: "activity.stop_all", ghostId: f.ghost.id });
      expect(f.ledger.activity(id).paused).toBe(true);
      expect(f.ledger.work(f.ledger.activityRuns(id)[0]!.workId!).state).toBe("cancelled");
      expect(f.ledger.activity(other.activityId as string).paused).toBe(false);
      await f.send({ type: "activity.stop_all" });
      expect(f.ledger.activity(other.activityId as string).paused).toBe(true);
      const remove = request({ type: "activity.delete", activityId: id });
      await execute(f.core, f.owner, remove, context);
      const deleted = f.ledger.activity(id);
      await execute(f.core, f.owner, remove, context);
      expect(f.ledger.activity(id)).toEqual(deleted);
      expect(deleted.deletedAt).not.toBeNull();
    } finally { await f.close(); }
  });

  test("activity mutations and run+Work admissions roll back with failed success receipts", async () => {
    const f = fixture();
    try {
      const create = request({ type: "activity.create", config: f.config });
      rejectSuccess(f.ledger, create.requestId);
      await expect(execute(f.core, f.owner, create, context)).rejects.toThrow("receipt fault");
      expect(f.ledger.activities()).toHaveLength(0);
      f.ledger.db.exec("DROP TRIGGER reject_autonomy_receipt");
      const { activityId } = await execute(f.core, f.owner, create, context);
      const run = request({ type: "activity.run", activityId: activityId as string });
      rejectSuccess(f.ledger, run.requestId);
      await expect(execute(f.core, f.owner, run, context)).rejects.toThrow("receipt fault");
      expect(f.ledger.activityRuns(activityId as string)).toHaveLength(0);
      expect(f.ledger.worksForState()).toHaveLength(0);
      expect(f.ledger.request(run.requestId)?.state).toBe("pending");
      f.ledger.db.exec("DROP TRIGGER reject_autonomy_receipt");
      await execute(f.core, f.owner, run, context);
      expect(f.ledger.activityRuns(activityId as string)).toHaveLength(1);
      await f.core.idle();
      const before = f.ledger.activity(activityId as string);
      const stop = request({ type: "activity.stop_all", ghostId: f.ghost.id });
      rejectSuccess(f.ledger, stop.requestId);
      await expect(execute(f.core, f.owner, stop, context)).rejects.toThrow("receipt fault");
      expect(f.ledger.activity(activityId as string)).toEqual(before);
      expect(f.ledger.work(f.ledger.activityRuns(activityId as string)[0]!.workId!).state).not.toBe("cancelled");
      f.ledger.db.exec("DROP TRIGGER reject_autonomy_receipt");
    } finally { await f.close(); }
  });

  test("connection creation reserves its identity, joins retries and never journals secrets", async () => {
    const f = fixture();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const set = f.sources.setCredential.bind(f.sources);
      let writes = 0;
      f.sources.setCredential = async (id, value, version) => {
        writes++;
        entered.resolve();
        await release.promise;
        await set(id, value, version);
      };
      // A pending model approval must not exclude this explicit owner API mutation.
      f.core.effects.onApproved("test_write", async () => { throw new Error("pending fixture approval must not execute"); });
      f.core.effects.propose({ conversationId: f.ghost.directConversationId, callId: "model-approval", tool: "test_write", input: {}, summary: "Pending", title: "Allow?", detail: "Pending", proposal: {} });
      const req = request({ type: "connection.upsert", name: "GitHub", config: github, credential: "owner-private-token" });
      const first = execute(f.core, f.owner, req, context);
      const retry = execute(f.core, f.owner, req, context);
      await entered.promise;
      const claim = f.ledger.request(req.requestId)!;
      const id = claim.outcome.connectionId as string;
      expect(id).toBeString();
      expect(claim).toMatchObject({ state: "pending", outcome: { conversationId: f.ghost.directConversationId } });
      expect(f.ledger.connection(id)).toMatchObject({ hasCredential: false });
      expect(f.ledger.connection(id).credentialVersion).not.toBeNull();
      release.resolve();
      const result = await first;
      expect(await retry).toEqual(result);
      expect(result).toEqual({ connectionId: id });
      expect(await execute(f.core, f.owner, req, context)).toEqual(result);
      expect(writes).toBe(1);
      expect(f.ledger.connections()).toHaveLength(1);
      expect(f.ledger.connection(id).hasCredential).toBe(true);
      const effect = f.ledger.effectByCall(f.ghost.directConversationId, `api:${req.requestId}`)!;
      expect(effect).toMatchObject({ state: "done", result: `api-result:${JSON.stringify(result)}` });
      expect(JSON.stringify({ effect, receipt: f.ledger.request(req.requestId), connection: f.ledger.connection(id) })).not.toContain("owner-private-token");
    } finally { await f.close(); }
  });

  test("all account configuration changes require explicit credential intent; name-only edits preserve versions", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "GitHub", config: github, credential: "token" });
      const id = connectionId as string;
      const before = f.ledger.connection(id);
      await expect(f.send({ type: "connection.upsert", connectionId: id, name: "Other", config: { ...github, baseUrl: "https://different.example/api" } })).rejects.toThrow("re-enter");
      expect(f.ledger.connection(id)).toEqual(before);
      await f.send({ type: "connection.upsert", connectionId: id, name: "Renamed", config: github });
      expect(f.ledger.connection(id)).toMatchObject({ name: "Renamed", hasCredential: true, credentialVersion: before.credentialVersion });
      await f.send({ type: "connection.upsert", connectionId: id, name: "Disconnected", config: { ...github, baseUrl: "https://different.example/api" }, credential: null });
      expect(f.ledger.connection(id)).toMatchObject({ hasCredential: false, credentialVersion: null });
      expect(f.sources.credentialPresent(id)).toBe(false);
      await expect(f.sources.test(before)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("credential rotation disconnects first, rejects stale sources, and serializes metadata/test commands", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "Old", config: github, credential: "old-token" });
      const id = connectionId as string;
      const old = f.ledger.connection(id);
      const set = f.sources.setCredential.bind(f.sources);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.sources.setCredential = async (connectionId, value, version) => {
        await set(connectionId, value, version);
        entered.resolve();
        await release.promise;
      };
      const rotate = f.send({ type: "connection.upsert", connectionId: id, name: "Rotated", config: github, credential: "new-token" });
      await entered.promise;
      const staged = f.ledger.connection(id);
      expect(staged.hasCredential).toBe(false);
      expect(staged.credentialVersion).not.toBe(old.credentialVersion);
      expect(f.sources.credentialPresent(id)).toBe(false);
      await expect(f.sources.test(old)).rejects.toThrow();
      await expect(f.sources.test(staged)).rejects.toThrow();
      const metadata = f.send({ type: "connection.upsert", connectionId: id, name: "Metadata after rotation", config: github });
      const tested = f.send({ type: "connection.test", connectionId: id });
      await Promise.resolve();
      expect(f.ledger.connection(id).name).toBe("Rotated");
      expect(f.calls).toHaveLength(0);
      release.resolve();
      await rotate;
      await metadata;
      expect((await tested).summary).toContain("authentication succeeded");
      expect(f.ledger.connection(id)).toMatchObject({ name: "Metadata after rotation", hasCredential: true, credentialVersion: staged.credentialVersion });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.authorization).toBe("Bearer new-token");
      await expect(f.sources.test(old)).rejects.toThrow();
      expect(f.calls).toHaveLength(1);
    } finally { await f.close(); }
  });

  for (const operation of ["connection.upsert", "connection.delete"] as const) {
    test(`${operation}: uncertain credential writes leave a disconnected row and never replay`, async () => {
      const f = fixture();
      try {
        const { connectionId } = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "old-token" });
        const id = connectionId as string;
        const before = f.ledger.connection(id);
        const set = f.sources.setCredential.bind(f.sources);
        let writes = 0;
        f.sources.setCredential = async (id, value, version) => { writes++; await set(id, value, version); throw new Error(`provider echoed ${value}`); };
        const req = request(operation === "connection.delete" ? { type: operation, connectionId: id } : { type: operation, connectionId: id, name: "Changed", config: github, credential: "must-not-leak" });
        await expect(execute(f.core, f.owner, req, context)).rejects.toThrow("unknown outcome");
        expect(f.ledger.connection(id).hasCredential).toBe(false);
        expect(f.ledger.request(req.requestId)?.state).toBe("pending");
        const effect = f.ledger.effectByCall(f.ghost.directConversationId, `api:${req.requestId}`)!;
        expect(effect.state).toBe("unknown");
        expect(JSON.stringify(effect)).not.toContain("must-not-leak");
        expect(f.ledger.pendingDecisions({ effectId: effect.id })).toHaveLength(1);
        await expect(execute(f.core, f.owner, req, context)).rejects.toThrow("unknown");
        expect(writes).toBe(1);
        await expect(f.sources.test(before)).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
      } finally { await f.close(); }
    });
  }

  test("credential completion, metadata and receipt commit atomically; failed final commit cannot replay IO", async () => {
    const f = fixture();
    try {
      const req = request({ type: "connection.upsert", name: "Account", config: github, credential: "token" });
      rejectSuccess(f.ledger, req.requestId);
      await expect(execute(f.core, f.owner, req, context)).rejects.toThrow("unknown outcome");
      const claim = f.ledger.request(req.requestId)!;
      const id = claim.outcome.connectionId as string;
      expect(f.ledger.connections()).toHaveLength(1);
      expect(f.ledger.connection(id).hasCredential).toBe(false);
      expect(claim.state).toBe("pending");
      expect(f.sources.credentialPresent(id)).toBe(false);
      f.ledger.db.exec("DROP TRIGGER reject_autonomy_receipt");
      await expect(execute(f.core, f.owner, req, context)).rejects.toThrow("unknown");
      expect(f.ledger.connections()).toHaveLength(1);
      await f.send({ type: "connection.upsert", connectionId: id, name: "Recovered", config: github, credential: "recovery-token" });
      expect(f.ledger.connection(id).hasCredential).toBe(true);
    } finally { await f.close(); }
  });

  test("connection tests replay real summaries and deletion removes credentials only once", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "token" });
      const id = connectionId as string;
      const tested = request({ type: "connection.test", connectionId: id });
      const result = await execute(f.core, f.owner, tested, context);
      expect(result.summary).toContain("authentication succeeded");
      expect(await execute(f.core, f.owner, tested, context)).toEqual(result);
      expect(f.calls).toHaveLength(1);
      expect(f.ledger.effectByCall(f.ghost.directConversationId, `api:${tested.requestId}`)).toBeNull();
      const removed = request({ type: "connection.delete", connectionId: id });
      expect(await execute(f.core, f.owner, removed, context)).toEqual({});
      expect(f.ledger.findConnection(id)).toBeNull();
      expect(f.sources.credentialPresent(id)).toBe(false);
      expect(await execute(f.core, f.owner, removed, context)).toEqual({});
      await expect(f.send({ type: "connection.upsert", connectionId: id, name: "Stale edit", config: github })).rejects.toThrow();
      expect(f.ledger.findConnection(id)).toBeNull();
    } finally { await f.close(); }
  });

  test("metadata-only receipt failure rolls back without touching the credential journal", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "token" });
      const id = connectionId as string;
      const before = f.ledger.connection(id);
      const req = request({ type: "connection.upsert", connectionId: id, name: "Rename", config: github });
      rejectSuccess(f.ledger, req.requestId);
      await expect(execute(f.core, f.owner, req, context)).rejects.toThrow("receipt fault");
      expect(f.ledger.connection(id)).toEqual(before);
      expect(f.sources.credentialPresent(id)).toBe(true);
      expect(f.ledger.effectByCall(f.ghost.directConversationId, `api:${req.requestId}`)).toBeNull();
      f.ledger.db.exec("DROP TRIGGER reject_autonomy_receipt");
      expect(await execute(f.core, f.owner, req, context)).toEqual({ connectionId: id });
      expect(f.ledger.connection(id)).toMatchObject({ name: "Rename", credentialVersion: before.credentialVersion });
    } finally { await f.close(); }
  });

  test("failed real connection tests stay retryable rather than recording fabricated success", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "Disconnected", config: github });
      const id = connectionId as string;
      const req = request({ type: "connection.test", connectionId: id });
      await expect(execute(f.core, f.owner, req, context)).rejects.toThrow();
      expect(f.ledger.request(req.requestId)?.state).toBe("pending");
      expect(f.calls).toHaveLength(0);
      expect(f.ledger.effectByCall(f.ghost.directConversationId, `api:${req.requestId}`)).toBeNull();
      await f.send({ type: "connection.upsert", connectionId: id, name: "Ready", config: github, credential: "token" });
      expect((await execute(f.core, f.owner, req, context)).summary).toContain("authentication succeeded");
      expect(f.calls).toHaveLength(1);
    } finally { await f.close(); }
  });

  test("invalid credential/configuration validation produces no effect or disconnected replacement", async () => {
    const f = fixture();
    try {
      const { connectionId } = await f.send({ type: "connection.upsert", name: "Account", config: github, credential: "token" });
      const id = connectionId as string;
      const before = f.ledger.connection(id);
      for (const command of [
        { type: "connection.upsert", connectionId: id, name: "Bad", config: github, credential: "bad\nsecret" },
        { type: "connection.upsert", connectionId: id, name: "Bad", config: { kind: "github", baseUrl: "http://insecure.example" }, credential: "token" },
      ] satisfies Command[]) {
        const req = request(command);
        await expect(execute(f.core, f.owner, req, context)).rejects.toThrow();
        expect(f.ledger.effectByCall(f.ghost.directConversationId, `api:${req.requestId}`)).toBeNull();
        expect(f.ledger.connection(id)).toEqual(before);
      }
    } finally { await f.close(); }
  });
});
