import { describe, expect, it } from "vitest";
import type { Response, Snapshot } from "../../../../contracts/lifetime/bindings.ts";
import { createLifetimeClient } from "./client";
import type { LifetimeClientOptions, LifetimeStorage, LifetimeTransport } from "./types";

const durableResponse: Response = { status: "success", summary: "Durable command receipt recovered.", object_refs: [], artifacts: [], next_actions: [], error_code: null, retry_class: "same_id", data: null };
const fixtureSnapshot: Snapshot = { protocol_version: "ghost-lifetime/1", contract_revision: 1, mode: "fixture", goals: [], work: [], bindings: [], artifacts: [], acceptances: [] };
const command = { method: "goal.submit", ghost_id: "11111111-1111-4111-8111-111111111111", conversation_id: "22222222-2222-4222-8222-222222222222", prompt: "Create the requested artifact", privacy: "public", acceptance_spec: {} };

function memoryStorage(): LifetimeStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    listKeys: () => [...values.keys()],
  };
}

function options(workspace_id: string, authority_epoch: number, dispatch_enabled = true): LifetimeClientOptions {
  return { actor_ref: "owner", authority_epoch, workspace_id, dispatch_enabled };
}

describe("lifetime client outbox", () => {
  it("inspects a lost receipt without replaying the original mutation", async () => {
    const storage = memoryStorage();
    const receipts = new Map<string, Response>();
    let effects = 0;
    let inspections = 0;
    let loseFirstReply = true;
    const authority = options("11111111-1111-4111-8111-111111111111", 1);
    const transport: LifetimeTransport = {
      identity: { actor_ref: "owner", authority_epoch: 1 },
      snapshot: async () => fixtureSnapshot,
      async request(envelope) {
        if (envelope.body.method === "command.inspect") {
          inspections += 1;
          const commandId = String(envelope.body.command_id);
          const receipt = receipts.get(commandId);
          return receipt
            ? {
              ...durableResponse,
              data: { command_id: commandId, found: true, authority_epoch: 1, payload_digest: saved.payload_digest, response: receipt },
            }
            : {
              ...durableResponse,
              status: "warning",
              error_code: "not_found",
              retry_class: "reconcile_first",
              data: { command_id: commandId, found: false },
            };
        }
        let receipt = receipts.get(envelope.command_id);
        if (!receipt) {
          effects += 1;
          receipt = { ...durableResponse, object_refs: [`goal-${effects}`] };
          receipts.set(envelope.command_id, receipt);
        }
        if (loseFirstReply) {
          loseFirstReply = false;
          throw new Error("reply lost after durable receipt");
        }
        return receipt;
      },
    };
    const first = createLifetimeClient(transport, storage, authority);
    await expect(first.request(command)).rejects.toThrow("reply lost");
    expect(effects).toBe(1);

    const saved = (await first.pendingCommands())[0]!;
    const restarted = createLifetimeClient(transport, storage, authority);
    await expect(restarted.request({ ...command, prompt: "different intent" })).rejects.toThrow("persisted Lifetime command");
    expect(effects).toBe(1);
    expect((await restarted.retry(saved.command_id)).object_refs).toEqual(["goal-1"]);
    expect(inspections).toBe(1);
    expect(effects).toBe(1);
    expect(await restarted.pendingCommands()).toEqual([]);

    expect((await restarted.request(command)).object_refs).toEqual(["goal-2"]);
    expect(effects).toBe(2);
  });

  it("retains an unknown old-workspace epoch and blocks writes when inspection confirms absence", async () => {
    const storage = memoryStorage();
    const oldAuthority = options("11111111-1111-4111-8111-111111111111", 1);
    const oldTransport: LifetimeTransport = {
      identity: { actor_ref: "owner", authority_epoch: 1 },
      snapshot: async () => fixtureSnapshot,
      request: async () => { throw new Error("connection lost after dispatch"); },
    };
    const oldClient = createLifetimeClient(oldTransport, storage, oldAuthority);
    await expect(oldClient.request(command)).rejects.toThrow("connection lost");
    const original = (await oldClient.pendingCommands())[0]!;
    const inspectCalls: string[] = [];
    const currentTransport: LifetimeTransport = {
      identity: { actor_ref: "owner", authority_epoch: 2 },
      snapshot: async () => fixtureSnapshot,
      async request(envelope) {
        inspectCalls.push(envelope.body.method as string);
        expect(envelope.actor_ref).toBe("owner");
        expect(envelope.authority_epoch).toBe(2);
        expect(envelope.body).toEqual({ method: "command.inspect", command_id: original.command_id });
        return {
          status: "warning",
          summary: "No receipt exists.",
          object_refs: [],
          artifacts: [],
          next_actions: [],
          error_code: "not_found",
          retry_class: "reconcile_first",
          data: { command_id: original.command_id, found: false },
        };
      },
    };
    const current = createLifetimeClient(currentTransport, storage, options(oldAuthority.workspace_id, 2));
    const [recovery] = await current.recoveryCommands();
    expect(recovery).toMatchObject({
      workspace_id: oldAuthority.workspace_id,
      actor_ref: "owner",
      authority_epoch: 1,
      command_id: original.command_id,
      envelope: original,
    });
    await expect(current.request(command)).rejects.toThrow("Earlier unresolved Lifetime commands");
    expect(await current.reconcile(recovery!.id)).toMatchObject({ status: "not_found", command_id: original.command_id, authority_epoch: 1 });
    expect(inspectCalls).toEqual(["command.inspect"]);
    expect(await current.recoveryCommands()).toHaveLength(1);
    await expect(current.request(command)).rejects.toThrow("Earlier unresolved Lifetime commands");
  });

  it("retires an old journal only after explicit inspection confirms its original success", async () => {
    const storage = memoryStorage();
    const oldAuthority = options("11111111-1111-4111-8111-111111111111", 1);
    const oldClient = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 1 },
      snapshot: async () => fixtureSnapshot,
      request: async () => { throw new Error("reply lost"); },
    }, storage, oldAuthority);
    await expect(oldClient.request(command)).rejects.toThrow("reply lost");
    const original = (await oldClient.pendingCommands())[0]!;
    const inspected: string[] = [];
    const current = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 2 },
      snapshot: async () => fixtureSnapshot,
      async request(envelope) {
        if (envelope.body.method === "command.inspect") {
          inspected.push(envelope.body.command_id as string);
          return {
            ...durableResponse,
            data: { command_id: original.command_id, found: true, authority_epoch: 1, payload_digest: original.payload_digest, response: durableResponse },
          };
        }
        return durableResponse;
      },
    }, storage, options(oldAuthority.workspace_id, 2));
    const recovery = (await current.recoveryCommands())[0]!;
    expect(await current.reconcile(recovery.id)).toMatchObject({ status: "confirmed_success", command_id: original.command_id, authority_epoch: 1 });
    expect(inspected).toEqual([original.command_id]);
    expect(await current.recoveryCommands()).toEqual([]);
    expect(await current.request(command)).toEqual(durableResponse);
  });

  it("retains original intent when receipt digest mismatches or an old error lacks rollback proof", async () => {
    const storage = memoryStorage();
    const authority = options("11111111-1111-4111-8111-111111111111", 1);
    const first = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 1 }, snapshot: async () => fixtureSnapshot,
      request: async () => { throw new Error("response lost"); },
    }, storage, authority);
    await expect(first.request(command)).rejects.toThrow("response lost");
    const original = (await first.pendingCommands())[0]!;
    const key = (await storage.listKeys())[0]!;
    const before = await storage.getItem(key);
    let wrongDigest = true;
    const inspected: string[] = [];
    const current = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 2 }, snapshot: async () => fixtureSnapshot,
      request: async envelope => {
        inspected.push(String(envelope.body.method));
        return { ...durableResponse, data: {
          command_id: original.command_id, found: true, authority_epoch: 1,
          payload_digest: wrongDigest ? "0".repeat(64) : original.payload_digest,
          response: { ...durableResponse, status: "error", error_code: "conflict", retry_class: "new_revision", data: null },
        } };
      },
    }, storage, options(authority.workspace_id, 2));
    const [recovery] = await current.recoveryCommands();
    expect(await current.reconcile(recovery!.id)).toMatchObject({ status: "unresolved", command_id: original.command_id });
    wrongDigest = false;
    expect(await current.reconcile(recovery!.id)).toMatchObject({ status: "unresolved", command_id: original.command_id });
    await expect(current.request({ method: "work.delegate", parent_work_id: "work" })).rejects.toThrow("Earlier unresolved Lifetime commands");
    expect(await storage.getItem(key)).toBe(before);
    expect(inspected).toEqual(["command.inspect", "command.inspect"]);
  });

  it("does not inspect a foreign workspace even when it advertises the same command ID", async () => {
    const storage = memoryStorage();
    const first = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 1 }, snapshot: async () => fixtureSnapshot,
      request: async () => { throw new Error("response lost"); },
    }, storage, options("11111111-1111-4111-8111-111111111111", 1));
    await expect(first.request(command)).rejects.toThrow("response lost");
    const original = (await first.pendingCommands())[0]!;
    const requests: string[] = [];
    const current = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 2 }, snapshot: async () => fixtureSnapshot,
      request: async envelope => {
        requests.push(String(envelope.body.method));
        return { ...durableResponse, data: { command_id: original.command_id, found: true,
          authority_epoch: 1, payload_digest: original.payload_digest, response: durableResponse } };
      },
    }, storage, options("33333333-3333-4333-8333-333333333333", 2));
    const [recovery] = await current.recoveryCommands();
    expect(recovery!.issue).toBe("workspace_unbound_or_different");
    expect(await current.reconcile(recovery!.id)).toMatchObject({ status: "unresolved", command_id: original.command_id });
    expect((await first.pendingCommands())[0]).toEqual(original);
    expect(requests).toEqual([]);
  });

  it("keeps status readable while restored read-only authority blocks new mutations", async () => {
    let snapshots = 0;
    const methods: string[] = [];
    const client = createLifetimeClient({
      identity: { actor_ref: "owner", authority_epoch: 4 },
      snapshot: async () => { snapshots += 1; return fixtureSnapshot; },
      request: async envelope => {
        methods.push(String(envelope.body.method));
        return durableResponse;
      },
    }, memoryStorage(), options("44444444-4444-4444-8444-444444444444", 4, false));
    await expect(client.snapshot()).resolves.toBe(fixtureSnapshot);
    await expect(client.request({ method: "goal.inspect", goal_id: "goal-1" })).resolves.toBe(durableResponse);
    await expect(client.request(command)).rejects.toThrow("restored read-only");
    expect(snapshots).toBe(1);
    expect(methods).toEqual(["goal.inspect"]);
  });
});
