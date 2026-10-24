import type { Envelope as ControlEnvelope } from "../client/types";
import type { LifetimeIdentity, LifetimeTransport } from "./types";
import { assertLifetimeIdentity, createEnvelope, parseLifetimeEnvelope, parseLifetimeResponse, parseLifetimeSnapshot } from "./protocol";
import { isRecord } from "./guards";
import type { Envelope } from "../../../../contracts/lifetime/bindings.ts";

export type AuthenticatedControlAction = (envelope: ControlEnvelope) => Promise<unknown>;

/** Attaches the lifetime wire envelope to the existing authenticated control action only. */
export function createLifetimeControlTransport(action: AuthenticatedControlAction, identity: LifetimeIdentity): LifetimeTransport {
  assertLifetimeIdentity(identity);
  const call = async (envelope: Envelope) => {
    const validated = await parseLifetimeEnvelope(envelope);
    if (validated.actor_ref !== identity.actor_ref || validated.authority_epoch !== identity.authority_epoch) {
      throw new Error("Lifetime command identity must match authenticated transport configuration.");
    }
    const reply = await action({
      request_id: crypto.randomUUID(),
      command: { type: "lifetime", envelope: validated },
    });
    let result = reply;
    if (isRecord(reply) && "ok" in reply) {
      if (reply.ok !== true) throw new Error(typeof reply.error === "string" ? reply.error : "Ghost Host rejected the lifetime request.");
      if (!("result" in reply)) throw new Error("Ghost Host response is missing its result.");
      result = reply.result;
    }
    return parseLifetimeResponse(result);
  };
  return {
    identity: { ...identity },
    request: call,
    async snapshot() {
      const envelope = await createEnvelope({ method: "snapshot" }, identity);
      const response = await call(envelope);
      if (response.status === "error") throw new Error(response.summary || "Lifetime snapshot could not be loaded.");
      return parseLifetimeSnapshot(response.data);
    },
  };
}
