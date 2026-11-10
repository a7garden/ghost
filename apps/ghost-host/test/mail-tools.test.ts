import { expect, spyOn, test } from "bun:test";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Connection } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { MailService } from "../src/integrations/mail.ts";
import { createMailTools } from "../src/tools/mail.ts";
import { harness } from "./support.ts";

function fixture(tools: ("mail_send" | "mail_read" | "mail_update" | "mail_search")[] = ["mail_send", "mail_read", "mail_update", "mail_search"]) {
  const f = harness();
  const ghost = f.core.createGhost({ name: "Mail Ghost", persona: "", isDefault: true, tools });
  f.ledger.setPiConversationId(ghost.directConversationId, "100");
  const connection: Connection = { id: "account", name: "Owner mail", config: { kind: "mail", host: "imap.example.com", port: 993, username: "owner@example.com", mailbox: "INBOX", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: true }, hasCredential: true, credentialVersion: "v1", createdAt: 1, updatedAt: 1 };
  const connections = [connection];
  const mail = new MailService({ connections: () => connections, sources: { credentialPresent: () => true, mailAuthority: () => { throw new Error("network forbidden in tool fixture"); } } });
  const send = spyOn(mail, "send").mockResolvedValue({ messageId: "<sent@example.com>", sentCopy: true });
  const extension = createMailTools(f.core, mail);
  const context = { abortSignal: undefined } as Context;
  const api = { conversationId: 100, callId: "send-call" } as unknown as ToolExecutionApi;
  return { ...f, ghost, mail, send, extension, api, context, connections, async close() { send.mockRestore(); await mail.close(); f.core.stop(); await f.core.idle(); f.ledger.close(); } };
}
const message = { account: "account", to: ["recipient@example.com"], subject: "검토 요청", text: "본문 전체를 확인해 주세요." };

test("ungranted mail tools refuse every execution before accessing mail", async () => {
  const f = fixture([]);
  try {
    for (const tool of f.extension.tools!) {
      const result = await tool.execute(message as never, f.api, f.context);
      expect(result.isError).toBe(true);
    }
    expect(f.send).not.toHaveBeenCalled(); expect(f.ledger.pendingDecisions()).toHaveLength(0);
  } finally { await f.close(); }
});

test("mail_send persists approval with complete body and sends once only after owner approval", async () => {
  const f = fixture();
  try {
    const tool = f.extension.tools!.find(tool => tool.name === "mail_send")!;
    expect((await tool.execute(message as never, f.api, f.context)).isError).toBeFalsy();
    expect(f.send).not.toHaveBeenCalled();
    const decision = f.ledger.pendingDecisions()[0]!;
    expect(decision.kind).toBe("approve_effect"); expect(decision.detail).toContain(message.text); expect(decision.detail).toContain(message.to[0]!);
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    await f.core.effects.resolveApproval(decision.effectId!, true);
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.ledger.effect(decision.effectId!).state).toBe("done");
  } finally { await f.close(); }
});

test("approval refuses revoked grants; body beyond full review size is refused", async () => {
  const f = fixture();
  try {
    const tool = f.extension.tools!.find(tool => tool.name === "mail_send")!;
    const oversized = await tool.execute({ ...message, text: "한".repeat(6000) } as never, f.api, f.context);
    expect(oversized.isError).toBe(true); expect(f.ledger.pendingDecisions()).toHaveLength(0);
    await tool.execute(message as never, { ...f.api, callId: "valid-call" }, f.context);
    const decision = f.ledger.pendingDecisions()[0]!;
    f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), tools: [] }));
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
  } finally { await f.close(); }
});

test("same command request id joins in-flight send then returns one durable success receipt", async () => {
  const f = fixture();
  try {
    const request = { requestId: crypto.randomUUID(), command: { type: "mail.send" as const, connectionId: "account", to: message.to, subject: message.subject, text: message.text } };
    const access = new Access({ kind: "owner" }), context = { publicOrigin: "http://localhost", documents: null, mail: f.mail };
    const results = await Promise.all([execute(f.core, access, request, context), execute(f.core, access, request, context)]);
    expect(results[0]).toEqual({ messageId: "<sent@example.com>", sentCopy: true }); expect(results[1]).toEqual(results[0]);
    expect(await execute(f.core, access, request, context)).toEqual(results[0]); expect(f.send).toHaveBeenCalledTimes(1);
    await expect(execute(f.core, access, { ...request, command: { ...request.command, text: "Different body" } }, context)).rejects.toThrow("different command");
  } finally { await f.close(); }
});

test("uncertain SMTP command becomes unknown and is never resent on retry", async () => {
  const f = fixture();
  f.send.mockRejectedValue(new Error("sanitized uncertain SMTP outcome"));
  try {
    const request = { requestId: crypto.randomUUID(), command: { type: "mail.send" as const, connectionId: "account", to: message.to, subject: message.subject, text: message.text } };
    const access = new Access({ kind: "owner" }), context = { publicOrigin: "http://localhost", documents: null, mail: f.mail };
    await expect(execute(f.core, access, request, context)).rejects.toThrow();
    expect(f.ledger.effectsInState("unknown")).toHaveLength(1);
    await expect(execute(f.core, access, request, context)).rejects.toThrow("will not run again");
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test("deleted account after approval is denied, never recorded as an unknown send", async () => {
  const f = fixture();
  try {
    const tool = f.extension.tools!.find(tool => tool.name === "mail_send")!;
    await tool.execute(message as never, f.api, f.context);
    const decision = f.ledger.pendingDecisions()[0]!;
    f.connections.splice(0);
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.ledger.effectsInState("unknown")).toHaveLength(0);
  } finally { await f.close(); }
});

for (const refusal of ["deadline", "activity"] as const) test(`approval rechecks current Work ${refusal} authority`, async () => {
  const f = fixture();
  try {
    const root = f.core.works.createRoot({ ghostId: f.ghost.id, title: "Reply", brief: "Reply after approval", originConversationId: f.ghost.directConversationId });
    await f.core.idle();
    const work = f.ledger.work(root.id);
    expect(work.conversationId).not.toBeNull();
    f.ledger.setPiConversationId(work.conversationId!, "101");
    f.ledger.tx(() => f.ledger.putWork({ ...work, state: "running" }));
    const tool = f.extension.tools!.find(tool => tool.name === "mail_send")!;
    const result = await tool.execute(message as never, { ...f.api, conversationId: 101 } as unknown as ToolExecutionApi, f.context);
    expect(result.isError).toBeFalsy();
    const decision = f.ledger.pendingDecisions({ conversationId: work.conversationId! })[0]!;
    f.ledger.tx(() => f.ledger.putWork({ ...f.ledger.work(root.id), ...(refusal === "deadline" ? { deadlineAt: Date.now() - 1 } : { activityId: "revoked-activity", activityRunId: "invalidated-run" }) }));
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.ledger.effectsInState("unknown")).toHaveLength(0);
  } finally { await f.close(); }
});

test("valid long subject fits approval title while retaining the exact subject for approval and send", async () => {
  const f = fixture();
  try {
    const subject = "s".repeat(998);
    const tool = f.extension.tools!.find(tool => tool.name === "mail_send")!;
    const result = await tool.execute({ ...message, subject } as never, f.api, f.context);
    expect(result.isError).toBeFalsy();
    const decision = f.ledger.pendingDecisions()[0]!;
    expect(decision.title.length).toBeLessThanOrEqual(256);
    expect(decision.detail).toContain(subject);
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![1].subject).toBe(subject);
  } finally { await f.close(); }
});

for (const mode of ["read", "search", "accounts"] as const) test(`revoked mail ${mode} permission prevents disclosure after an awaited read`, async () => {
  const f = fixture();
  const secret = "must-not-disclose-mail-content";
  const revoke = () => f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), tools: [] }));
  const read = spyOn(f.mail, "read").mockImplementation(async () => {
    revoke();
    return { uid: 1, uidValidity: 1, messageId: null, from: null, to: [], cc: [], replyTo: [], subject: secret, date: 0, seen: false, flagged: false, answered: false, hasAttachments: false, size: 1, text: secret, html: null, attachments: [] };
  });
  const list = spyOn(f.mail, "list").mockImplementation(async () => {
    revoke();
    return { mailbox: secret, uidValidity: 1, messages: [], nextBefore: null };
  });
  const mailboxes = spyOn(f.mail, "mailboxes").mockImplementation(async () => {
    revoke();
    return [{ path: secret, name: secret, delimiter: null, specialUse: null, total: 0, unseen: 0 }];
  });
  try {
    const tool = f.extension.tools!.find(tool => tool.name === (mode === "read" ? "mail_read" : "mail_search"))!;
    const args = mode === "accounts" ? {} : { account: "account", mailbox: "INBOX", uid: 1 };
    const result = await tool.execute(args as never, f.api, f.context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally { read.mockRestore(); list.mockRestore(); mailboxes.mockRestore(); await f.close(); }
});
