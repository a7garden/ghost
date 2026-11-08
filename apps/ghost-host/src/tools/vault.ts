import { Type } from "typebox";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { SecureFormRequest, VaultItemKind, validate } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { idFor } from "../core/ids.ts";
import { Vault, normalizeOrigin } from "../stores/vault.ts";
import { invalid } from "../core/errors.ts";
import { errorResult, requireAllowed } from "./shared.ts";

export const VAULT_INSTRUCTIONS = "Use vault_list to choose granted credentials by exact HTTPS origin and owner hints. Use vault_request for a secure owner form; never ask for or accept passwords, codes, card values or secrets in chat. vault_generate_login saves a generated password without revealing it. Fill credentials only with browser_fill_secret; never try to reveal them.";

export function createVaultTools(core: Core, vault: Vault): Extension {
  return defineExtension({
    name: "ghost.vault",
    tools: [
      defineTool({
        name: "vault_list", description: "List granted vault metadata only. Exact HTTPS origin filter; owner hints help choose an item. No secret values are returned.",
        parameters: Type.Object({ origin: Type.Optional(Type.String({ maxLength: 2048 })), kind: Type.Optional(VaultItemKind) }), replay: "safe",
        async execute(args, api) {
          try {
            const scope = requireAllowed(core, api, "vault_list");
            const items = vault.listFor(scope.ghost.id, { ...args, origin: args.origin === undefined ? undefined : normalizeOrigin(args.origin) });
            return { content: [{ type: "text", text: items.length ? items.map((item) => JSON.stringify(item)).join("\n") : "No granted vault items." }] };
          } catch (error) { return errorResult(error); }
        },
      }),
      defineTool({
        name: "vault_request", description: "Ask the owner for credentials using a secure form, never chat. The answer contains only the new item id, kind and title.",
        parameters: Type.Object({ kind: VaultItemKind, origin: Type.Optional(Type.String({ maxLength: 2048 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })), reason: Type.String({ minLength: 1, maxLength: 2048 }) }), replay: "unsafe",
        async execute(args, api) {
          try {
            const scope = requireAllowed(core, api, "vault_request");
            const secureForm = { kind: args.kind, origin: args.origin === undefined ? null : normalizeOrigin(args.origin), title: args.title ?? null, reason: args.reason };
            if (!validate(SecureFormRequest, secureForm)) throw invalid("invalid secure form request");
            const decision = core.decisions.ask(scope.conversation.id, args.title ?? `Provide ${args.kind}`, args.reason, [], idFor(scope.conversation.id, api.callId), { secureForm });
            return { content: [{ type: "text", text: `Secure form requested (${decision.id}). The owner answers in the vault, not chat.` }] };
          } catch (error) { return errorResult(error); }
        },
      }),
      defineTool({
        name: "vault_generate_login", description: "Save a login with a cryptographically generated password, granted to this Ghost. Returns metadata only, never the password.",
        parameters: Type.Object({ origin: Type.String({ maxLength: 2048 }), username: Type.String({ maxLength: 512 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }), replay: "unsafe",
        async execute(args, api) {
          try {
            const scope = requireAllowed(core, api, "vault_generate_login");
            const item = vault.generateLogin(scope.ghost.id, { ...args, origin: normalizeOrigin(args.origin) }, idFor(scope.conversation.id, api.callId));
            return { content: [{ type: "text", text: JSON.stringify(item) }] };
          } catch (error) { return errorResult(error); }
        },
      }),
    ],
  });
}
