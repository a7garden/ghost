import type { Envelope, Response, Snapshot } from "../../../../contracts/lifetime/bindings.ts";

export type { Acceptance, Artifact, Check, ComputerBinding, Envelope, Goal, Response, RuntimeBinding, Snapshot, Work, WorkerSpec } from "../../../../contracts/lifetime/bindings.ts";

export type LifetimeMode = "fixture" | "live";

export interface LifetimeIdentity {
  actor_ref: string;
  authority_epoch: number;
}

export interface LifetimeTransport {
  /** Authenticated actor and fence epoch supplied by the configured transport. */
  readonly identity?: LifetimeIdentity;
  request(envelope: Envelope): Promise<Response>;
  snapshot(): Promise<Snapshot>;
}

export interface LifetimeAuthority extends LifetimeIdentity {
  workspace_id: string;
  dispatch_enabled: boolean;
}

export interface LifetimeStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  listKeys(): string[] | Promise<string[]>;
}

export type LifetimeClientOptions = LifetimeAuthority;

export interface LifetimeRecoveryCommand {
  id: string;
  namespace: string;
  workspace_id: string | null;
  actor_ref: string | null;
  authority_epoch: number | null;
  request_id: string | null;
  command_id: string | null;
  envelope: Envelope | null;
  issue: string | null;
}

export interface LifetimeReconciliation {
  status: "confirmed_success" | "confirmed_no_effect" | "not_found" | "unresolved";
  command_id: string;
  authority_epoch: number;
}

export interface LifetimeClient {
  readonly workspace_id: string;
  readonly actor_ref: string;
  readonly authority_epoch: number;
  readonly dispatch_enabled: boolean;
  snapshot(): Promise<Snapshot>;
  request(body: Envelope["body"], expectedRevision?: number | null): Promise<Response>;
  retry(commandId: string): Promise<Response>;
  pendingCommands(): Promise<Envelope[]>;
  recoveryCommands(): Promise<LifetimeRecoveryCommand[]>;
  reconcile(recoveryId: string): Promise<LifetimeReconciliation>;
}
