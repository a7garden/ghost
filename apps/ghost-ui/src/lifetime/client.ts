import { VERSION } from "../../../../contracts/lifetime/bindings.ts";
import type { Envelope, Response } from "../../../../contracts/lifetime/bindings.ts";
import { isRecord } from "./guards";
import { createLifetimeControlTransport, type AuthenticatedControlAction } from "./controlTransport";
import { createBrowserLifetimeStorage } from "./browserStorage";
import { assertLifetimeIdentity, canonicalJson, createEnvelope, digestValue, parseLifetimeEnvelope, parseLifetimeResponse, parseLifetimeSnapshot } from "./protocol";
import type { LifetimeAuthority, LifetimeClient, LifetimeClientOptions, LifetimeReconciliation, LifetimeRecoveryCommand, LifetimeStorage, LifetimeTransport } from "./types";

interface PendingCommand {
  fingerprint: string;
  envelope: Envelope;
}

interface CommandJournal {
  protocol_version: typeof VERSION;
  commands: PendingCommand[];
}

interface ReceiptInspection {
  reconciliation: LifetimeReconciliation;
  response: Response;
}

type RecoverableCommand = LifetimeRecoveryCommand & {
  actor_ref: string;
  authority_epoch: number;
  command_id: string;
  envelope: Envelope;
};
const readOnlyMethods = new Set(["snapshot", "goal.inspect", "work.inspect", "work.children", "registry.inspect", "conversation.inspect", "conversation.turn.inspect", "mailbox.inspect", "notification.inspect", "command.inspect", "bot.surface.inspect", "bot.candidate.inspect", "bot.definition.inspect", "bot.lifecycle.inspect", "bot.discover"]);
const authoritativeNoEffectCodes = new Set(["authority_fenced", "conflict", "dispatch_off", "invalid_request", "not_found", "unauthorized", "unsupported_version"]);
const outboxPrefix = "ghost:lifetime:";
const workspacePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function namespaceWorkspace(key: string): string | null {
  const namespace = `ghost:lifetime:${VERSION}:workspace:`;
  if (key.startsWith(namespace)) {
    const value = key.slice(namespace.length).split(":actor:", 1)[0];
    try { return decodeURIComponent(value); } catch { return null; }
  }
  const legacy = key.slice(outboxPrefix.length).split(":");
  return key.startsWith(outboxPrefix) && legacy.length === 3 && legacy[2] === "outbox" && workspacePattern.test(legacy[0]!)
    ? legacy[0]!
    : null;
}

function fixtureNamespace(key: string): boolean {
  return key.startsWith(`ghost:lifetime:${VERSION}:workspace:fixture:`);
}


class PersistedLifetimeClient implements LifetimeClient {
  readonly workspace_id: string;
  readonly actor_ref: string;
  readonly authority_epoch: number;
  readonly dispatch_enabled: boolean;
  private readonly identity: { actor_ref: string; authority_epoch: number };
  private readonly key: string;
  private readonly activeIntents = new Map<string, Promise<Response>>();
  private readonly activeCommands = new Map<string, Promise<Response>>();
  private journalSerial: Promise<void> = Promise.resolve();

  constructor(private readonly transport: LifetimeTransport, private readonly storage: LifetimeStorage, options: LifetimeClientOptions) {
    this.identity = { actor_ref: options.actor_ref, authority_epoch: options.authority_epoch };
    assertLifetimeIdentity(this.identity);
    if (!options.workspace_id || typeof options.dispatch_enabled !== "boolean") throw new Error("Lifetime workspace and dispatch authority are not configured.");
    if (transport.identity && (transport.identity.actor_ref !== this.identity.actor_ref || transport.identity.authority_epoch !== this.identity.authority_epoch)) {
      throw new Error("Lifetime client identity must match authenticated transport configuration.");
    }
    this.workspace_id = options.workspace_id;
    this.actor_ref = this.identity.actor_ref;
    this.authority_epoch = this.identity.authority_epoch;
    this.dispatch_enabled = options.dispatch_enabled;
    this.key = `ghost:lifetime:${VERSION}:workspace:${encodeURIComponent(this.workspace_id)}:actor:${encodeURIComponent(this.identity.actor_ref)}:epoch:${this.identity.authority_epoch}:outbox`;
  }

  async snapshot() {
    return parseLifetimeSnapshot(await this.transport.snapshot());
  }

  async request(body: Envelope["body"], expectedRevision: number | null = null): Promise<Response> {
    const commandBody = structuredClone(body);
    const intent = canonicalJson({ body: commandBody, expected_revision: expectedRevision, actor_ref: this.identity.actor_ref, authority_epoch: this.identity.authority_epoch });
    const existing = this.activeIntents.get(intent);
    if (existing) return existing;
    const artifactRead = commandBody.method === "work.artifact";
    if (!artifactRead && !readOnlyMethods.has(String(commandBody.method))) await this.ensureMutationAllowed();
    // The Host keeps artifact reads out of its receipt table. A failed read
    // has no side effects and must not create a local request to reconcile.
    const operation = artifactRead
      ? createEnvelope(commandBody, this.identity, expectedRevision).then(envelope => this.transport.request(envelope)).then(parseLifetimeResponse)
      : this.requestIntent(commandBody, expectedRevision);
    this.activeIntents.set(intent, operation);
    void operation.then(() => this.activeIntents.delete(intent), () => this.activeIntents.delete(intent));
    return operation;
  }

  async retry(commandId: string): Promise<Response> {
    const candidate = await this.serializeJournal(async () => {
      const journal = await this.readJournal();
      const command = journal.commands.find(entry => entry.envelope.command_id === commandId
        && entry.envelope.actor_ref === this.identity.actor_ref
        && entry.envelope.authority_epoch === this.identity.authority_epoch);
      if (!command) throw new Error("저장된 요청을 현재 workspace 권한에서 찾지 못했습니다. 이전 요청은 영수증 확인이 필요합니다.");
      return this.recoveryCandidate(this.key, structuredClone(command.envelope));
    });
    const inspection = await this.inspectReceipt(candidate);
    if (inspection.reconciliation.status === "confirmed_success" || inspection.reconciliation.status === "confirmed_no_effect") {
      if (!await this.retireRecoveryCommand(candidate)) throw new Error("영수증은 확인했지만 저장 journal이 변경되어 원래 요청을 보존했습니다.");
    }
    return inspection.response;
  }

  async pendingCommands(): Promise<Envelope[]> {
    return this.serializeJournal(async () => (await this.readJournal()).commands
      .filter(command => command.envelope.actor_ref === this.identity.actor_ref && command.envelope.authority_epoch === this.identity.authority_epoch)
      // A read still running in this client is not an uncertain write. Keep its
      // journal entry, but don't let ordinary observation fence a new Owner
      // action or appear as a request that needs recovery. Failed reads and
      // reads owned by another client remain visible until reconciled.
      .filter(command => !readOnlyMethods.has(String(command.envelope.body.method))
        || !this.activeCommands.has(command.envelope.command_id))
      .map(command => structuredClone(command.envelope)));
  }
  async recoveryCommands(): Promise<LifetimeRecoveryCommand[]> {
    return this.serializeJournal(async () => {
      const listed = await this.storage.listKeys();
      if (!Array.isArray(listed) || listed.some(key => typeof key !== "string")) throw new Error("Lifetime outbox namespaces could not be enumerated safely.");
      const keys = new Set(listed.filter(key => key.startsWith(outboxPrefix) && key.endsWith(":outbox")));
      keys.add(this.key);
      const recovery: LifetimeRecoveryCommand[] = [];
      for (const key of [...keys].sort()) {
        if (fixtureNamespace(key)) continue;
        try {
          const journal = await this.readJournalAt(key);
          for (const command of journal.commands) {
            const envelope = command.envelope;
            if (key === this.key && envelope.actor_ref === this.identity.actor_ref && envelope.authority_epoch === this.identity.authority_epoch) continue;
            recovery.push({
              id: `${key}\u0000${envelope.command_id}`,
              namespace: key,
              workspace_id: namespaceWorkspace(key),
              actor_ref: envelope.actor_ref,
              authority_epoch: envelope.authority_epoch,
              request_id: null,
              command_id: envelope.command_id,
              envelope: structuredClone(envelope),
              issue: namespaceWorkspace(key) !== this.workspace_id ? "workspace_unbound_or_different" : envelope.actor_ref !== this.actor_ref ? "different_actor" : null
            });
          }
        } catch {
          recovery.push({
            id: `${key}\u0000unreadable`,
            namespace: key,
            workspace_id: namespaceWorkspace(key),
            actor_ref: null,
            authority_epoch: null,
            request_id: null,
            command_id: null,
            envelope: null,
            issue: "unreadable_outbox"
          });
        }
      }
      return recovery;
    });
  }

  async reconcile(recoveryId: string): Promise<LifetimeReconciliation> {
    const candidate = (await this.recoveryCommands()).find(command => command.id === recoveryId);
    if (candidate?.issue || candidate?.workspace_id !== this.workspace_id || !candidate?.envelope || !candidate.command_id || candidate.actor_ref !== this.actor_ref || candidate.authority_epoch === null) {
      return { status: "unresolved", command_id: candidate?.command_id ?? "", authority_epoch: candidate?.authority_epoch ?? 0 };
    }
    const recoverable: RecoverableCommand = {
      ...candidate,
      envelope: candidate.envelope,
      command_id: candidate.command_id,
      actor_ref: candidate.actor_ref,
      authority_epoch: candidate.authority_epoch
    };
    const inspection = await this.inspectReceipt(recoverable);
    if (inspection.reconciliation.status === "confirmed_success" || inspection.reconciliation.status === "confirmed_no_effect") {
      if (!await this.retireRecoveryCommand(recoverable)) {
        return { status: "unresolved", command_id: recoverable.command_id, authority_epoch: recoverable.authority_epoch };
      }
    }
    return inspection.reconciliation;
  }

  private recoveryCandidate(namespace: string, envelope: Envelope): RecoverableCommand {
    return {
      id: `${namespace}\u0000${envelope.command_id}`,
      namespace,
      workspace_id: namespaceWorkspace(namespace),
      actor_ref: envelope.actor_ref,
      authority_epoch: envelope.authority_epoch,
      request_id: null,
      command_id: envelope.command_id,
      envelope,
      issue: null
    };
  }

  private async inspectReceipt(candidate: RecoverableCommand): Promise<ReceiptInspection> {
    const original = await parseLifetimeEnvelope(candidate.envelope);
    if (original.command_id !== candidate.command_id
      || original.actor_ref !== candidate.actor_ref
      || original.authority_epoch !== candidate.authority_epoch) {
      throw new Error("Stored Lifetime command identity changed before receipt inspection.");
    }
    const inspect = await createEnvelope({ method: "command.inspect", command_id: candidate.command_id }, this.identity, null);
    const response = parseLifetimeResponse(await this.transport.request(inspect));
    const unresolved: LifetimeReconciliation = {
      status: "unresolved",
      command_id: candidate.command_id,
      authority_epoch: candidate.authority_epoch
    };
    const receipt = response.data;
    if (!isRecord(receipt) || receipt.command_id !== candidate.command_id || typeof receipt.found !== "boolean") {
      return { reconciliation: unresolved, response };
    }
    if (receipt.found === false) {
      const authoritativeAbsence = response.status === "warning"
        && response.error_code === "not_found"
        && response.retry_class === "reconcile_first";
      return {
        reconciliation: {
          status: authoritativeAbsence ? "not_found" : "unresolved",
          command_id: candidate.command_id,
          authority_epoch: candidate.authority_epoch
        },
        response
      };
    }
    if (response.status !== "success" || receipt.authority_epoch !== candidate.authority_epoch
      || receipt.payload_digest !== original.payload_digest || !isRecord(receipt.response)) {
      return { reconciliation: unresolved, response };
    }
    const originalResponse = parseLifetimeResponse(receipt.response);
    const confirmedSuccess = originalResponse.status === "success";
    const confirmedNoEffect = originalResponse.status === "error"
      && isRecord(originalResponse.data) && originalResponse.data.host_effect_class === "no_effect"
      && typeof originalResponse.error_code === "string"
      && authoritativeNoEffectCodes.has(originalResponse.error_code)
      && originalResponse.retry_class !== "reconcile_first";
    return {
      reconciliation: {
        status: confirmedSuccess ? "confirmed_success" : confirmedNoEffect ? "confirmed_no_effect" : "unresolved",
        command_id: candidate.command_id,
        authority_epoch: candidate.authority_epoch
      },
      response: confirmedSuccess || confirmedNoEffect ? originalResponse : response
    };
  }

  private async retireRecoveryCommand(candidate: RecoverableCommand): Promise<boolean> {
    return this.serializeJournal(async () => {
      const journal = await this.readJournalAt(candidate.namespace);
      const matching = journal.commands.filter(command => command.envelope.command_id === candidate.command_id
        && command.envelope.authority_epoch === candidate.authority_epoch
        && command.envelope.actor_ref === candidate.actor_ref
        && canonicalJson(command.envelope) === canonicalJson(candidate.envelope));
      if (matching.length !== 1) return false;
      const remaining = journal.commands.filter(command => command !== matching[0]);
      await this.writeJournalAt(candidate.namespace, { ...journal, commands: remaining });
      return true;
    });
  }

  private async ensureMutationAllowed(): Promise<void> {
    if (!this.dispatch_enabled) throw new Error("This Host is restored read-only; Lifetime changes are disabled.");
    if ((await this.recoveryCommands()).length > 0) throw new Error("Earlier unresolved Lifetime commands require explicit receipt reconciliation before new changes.");
    if ((await this.pendingCommands()).length > 0) throw new Error("A persisted Lifetime command requires explicit receipt inspection before new changes.");
  }

  private async requestIntent(body: Envelope["body"], expectedRevision: number | null): Promise<Response> {
    const fingerprint = await digestValue({ body, expected_revision: expectedRevision, actor_ref: this.identity.actor_ref, authority_epoch: this.identity.authority_epoch });
    const envelope = await this.serializeJournal(async () => {
      const journal = await this.readJournal();
      const matches = journal.commands.filter(command => command.fingerprint === fingerprint);
      if (matches.length > 1) throw new Error("Lifetime outbox contains duplicate identities for this pending request.");
      if (matches.length === 1) return structuredClone(matches[0]!.envelope);
      const created = await createEnvelope(body, this.identity, expectedRevision);
      journal.commands.push({ fingerprint, envelope: created });
      await this.writeJournal(journal);
      return structuredClone(created);
    });
    return this.dispatch(envelope);
  }


  private dispatch(envelope: Envelope): Promise<Response> {
    const existing = this.activeCommands.get(envelope.command_id);
    if (existing) return existing;
    const operation = this.sendAndSettle(envelope);
    this.activeCommands.set(envelope.command_id, operation);
    void operation.then(() => this.activeCommands.delete(envelope.command_id), () => this.activeCommands.delete(envelope.command_id));
    return operation;
  }

  private async sendAndSettle(envelope: Envelope): Promise<Response> {
    const validated = await parseLifetimeEnvelope(envelope);
    if (validated.actor_ref !== this.identity.actor_ref || validated.authority_epoch !== this.identity.authority_epoch) {
      throw new Error("Lifetime outbox identity no longer matches authenticated transport configuration.");
    }
    const response = parseLifetimeResponse(await this.transport.request(validated));
    const settled = response.status === "success" || (response.status === "error"
      && isRecord(response.data) && response.data.host_effect_class === "no_effect"
      && typeof response.error_code === "string"
      && authoritativeNoEffectCodes.has(response.error_code)
      && response.retry_class !== "reconcile_first");
    if (settled) {
      await this.serializeJournal(async () => {
        const journal = await this.readJournal();
        const remaining = journal.commands.filter(command => command.envelope.command_id !== validated.command_id);
        if (remaining.length !== journal.commands.length) await this.writeJournal({ ...journal, commands: remaining });
      });
    }
    return response;
  }

  private serializeJournal<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.journalSerial.then(work);
    this.journalSerial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private readJournal(): Promise<CommandJournal> {
    return this.readJournalAt(this.key);
  }

  private async readJournalAt(key: string): Promise<CommandJournal> {
    const encoded = await this.storage.getItem(key);
    if (encoded === null) return { protocol_version: VERSION, commands: [] };
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw new Error("Lifetime outbox storage is not valid JSON; unresolved command identities were left untouched.");
    }
    if (!isRecord(value) || value.protocol_version !== VERSION || !Array.isArray(value.commands)) {
      throw new Error("Lifetime outbox storage does not match contract revision 1; unresolved command identities were left untouched.");
    }
    const commands: PendingCommand[] = [];
    for (const item of value.commands) {
      if (!isRecord(item) || typeof item.fingerprint !== "string" || !isRecord(item.envelope)) throw new Error("Lifetime outbox contains a malformed command; unresolved command identities were left untouched.");
      const envelope = await parseLifetimeEnvelope(item.envelope);
      const expectedFingerprint = await digestValue({ body: envelope.body, expected_revision: envelope.expected_revision, actor_ref: envelope.actor_ref, authority_epoch: envelope.authority_epoch });
      if (item.fingerprint !== expectedFingerprint) throw new Error("Lifetime outbox command identity does not match its envelope.");
      commands.push({ fingerprint: item.fingerprint, envelope });
    }
    return { protocol_version: VERSION, commands };
  }

  private writeJournal(journal: CommandJournal): Promise<void> {
    return this.writeJournalAt(this.key, journal);
  }

  private async writeJournalAt(key: string, journal: CommandJournal): Promise<void> {
    await this.storage.setItem(key, JSON.stringify(journal));
  }
}

export function createLifetimeClient(transport: LifetimeTransport, storage: LifetimeStorage, options: LifetimeClientOptions): LifetimeClient {
  return new PersistedLifetimeClient(transport, storage, options);
}

export function createLiveLifetimeClient(action: AuthenticatedControlAction, authority: LifetimeAuthority, storage: LifetimeStorage = createBrowserLifetimeStorage()): LifetimeClient {
  if (!workspacePattern.test(authority.workspace_id) || authority.actor_ref !== "owner" || typeof authority.dispatch_enabled !== "boolean") {
    throw new Error("Live Lifetime requires validated workspace, owner, epoch, and dispatch authority from the authenticated Host snapshot.");
  }
  assertLifetimeIdentity({ actor_ref: authority.actor_ref, authority_epoch: authority.authority_epoch });
  return new PersistedLifetimeClient(
    createLifetimeControlTransport(action, { actor_ref: authority.actor_ref, authority_epoch: authority.authority_epoch }),
    storage,
    authority
  );
}
