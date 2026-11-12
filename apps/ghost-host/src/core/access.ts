import { OWNER_ONLY_COMMANDS, type Command, type Principal } from "@ghost/contract";
import { forbidden } from "./errors.ts";

/** A paired device has owner-equivalent capability except device management. */
export class Access {
  constructor(readonly principal: Principal) {}

  get isOwner() {
    return this.principal.kind === "owner";
  }

  /** Throws unless the principal may send this command. */
  authorize(command: Command) {
    if (this.principal.kind !== "owner" && this.principal.kind !== "device") throw forbidden("configuration commands require an owner principal");
    if (this.isOwner) return;
    if (!OWNER_ONLY_COMMANDS.includes(command.type)) return;
    if (command.type === "device.revoke" && this.principal.kind === "device" && command.deviceId === this.principal.deviceId) return;
    throw forbidden(`${command.type} needs the owner`);
  }
}
