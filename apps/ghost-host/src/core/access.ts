import { DEVICE_COMMANDS, type Command, type Principal } from "@ghost/contract";
import { forbidden } from "./errors.ts";

/** Devices share the owner's Ghost visibility, but may send only device commands. */
export class Access {
  constructor(readonly principal: Principal) {}

  get isOwner() {
    return this.principal.kind === "owner";
  }

  /** Throws unless the principal may send this command. */
  authorize(command: Command) {
    if (!this.isOwner && !DEVICE_COMMANDS.includes(command.type)) throw forbidden(`${command.type} needs the owner`);
  }
}
