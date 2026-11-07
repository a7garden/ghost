import { DEVICE_COMMANDS, type Command, type Conversation, type Decision, type Principal, type Work } from "@ghost/contract";
import type { Ledger } from "../ledger/ledger.ts";
import { forbidden } from "./errors.ts";

/**
 * What a principal may see and do. The owner sees everything. A device sees the
 * granted Ghosts' granted direct conversations and the Work that reports to them.
 */
export class Access {
  constructor(
    private readonly ledger: Ledger,
    readonly principal: Principal,
  ) {}

  get isOwner() {
    return this.principal.kind === "owner";
  }

  private grants() {
    return this.principal.kind === "device" ? this.principal.grants : [];
  }

  canSeeGhost(ghostId: string): boolean {
    return this.isOwner || this.grants().some((grant) => grant.ghostId === ghostId);
  }

  canSeeConversation(conversation: Conversation): boolean {
    if (this.isOwner) return true;
    if (conversation.kind === "direct") {
      return this.grants().some((grant) => grant.ghostId === conversation.ghostId && (grant.conversationId === null || grant.conversationId === conversation.id));
    }
    return conversation.workId !== null && this.canSeeWork(this.ledger.work(conversation.workId));
  }

  /** A Work is visible when its root reports to a visible direct conversation. */
  canSeeWork(work: Work): boolean {
    if (this.isOwner) return true;
    const root = work.rootId === work.id ? work : this.ledger.work(work.rootId);
    const origin = this.ledger.findConversation(root.originConversationId);
    return origin !== null && origin.kind === "direct" && this.canSeeConversation(origin);
  }

  canSeeDecision(decision: Decision): boolean {
    if (this.isOwner) return true;
    if (decision.workId) return this.canSeeWork(this.ledger.work(decision.workId));
    const conversation = this.ledger.findConversation(decision.conversationId);
    return conversation !== null && this.canSeeConversation(conversation);
  }

  /** Throws unless the principal may send this command for these targets. */
  authorize(command: Command) {
    if (this.isOwner) return;
    if (!DEVICE_COMMANDS.includes(command.type)) throw forbidden(`${command.type} needs the owner`);
    const deny = () => {
      throw forbidden("outside this device's grants");
    };
    switch (command.type) {
      case "message.send":
      case "message.cancel":
        if (!this.canSeeConversation(this.ledger.conversation(command.conversationId))) deny();
        return;
      case "work.create": {
        if (!this.canSeeGhost(command.ghostId)) deny();
        const origin = command.originConversationId ? this.ledger.conversation(command.originConversationId) : null;
        if (!origin) {
          const ghost = this.ledger.ghost(command.ghostId);
          if (!this.canSeeConversation(this.ledger.conversation(ghost.directConversationId))) deny();
        } else if (!this.canSeeConversation(origin)) deny();
        return;
      }
      case "work.update":
      case "work.cancel":
      case "work.resume":
        if (!this.canSeeWork(this.ledger.work(command.workId))) deny();
        return;
      case "decision.resolve":
        if (!this.canSeeDecision(this.ledger.decision(command.decisionId))) deny();
        return;
      case "notification.read":
        for (const id of command.notificationIds) {
          const notification = this.ledger.notification(id);
          if (notification.ghostId && !this.canSeeGhost(notification.ghostId)) deny();
        }
        return;
      case "device.push_register":
        return;
      default:
        deny();
    }
  }
}
