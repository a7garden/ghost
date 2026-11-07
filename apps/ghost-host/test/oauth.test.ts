import { afterEach, expect, test } from "bun:test";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { OAuthLogins } from "../src/api/oauth.ts";
import { settingsView } from "../src/core/commands.ts";
import { harness } from "./support.ts";

const resources: { close(): void }[] = [];
afterEach(() => { for (const resource of resources.splice(0)) resource.close(); });
const credential: OAuthCredential = { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 3600000, accountId: "account" };

function setup(login: OAuthAuth["login"]) {
  const { core, ledger } = harness();
  ledger.putProvider({ id: "codex", kind: "openai", name: "Codex", baseUrl: null, models: [{ id: "gpt-test", name: "Test" }] });
  const oauth = new OAuthLogins(core, { name: "test", login, refresh: async value => value, toAuth: async value => ({ apiKey: value.access }) });
  resources.push(oauth, { close: () => ledger.close() });
  return { core, ledger, oauth };
}


async function settled(oauth: OAuthLogins) {
  for (let turn = 0; turn < 100; turn++) {
    const status = oauth.status("codex");
    if (status.state !== "pending") return status;
    await Promise.resolve();
  }
  throw new Error("OAuth did not settle");
}

test("cancelled login cannot install late credentials; a new attempt can complete", async () => {
  const first = Promise.withResolvers<OAuthCredential>();
  let attempts = 0;
  const { core, oauth } = setup(async () => ++attempts === 1 ? first.promise : credential);
  oauth.start("codex");
  oauth.start("codex"); // a retry joins the pending login
  expect(attempts).toBe(1);
  expect(oauth.cancel("codex").state).toBe("cancelled");
  oauth.start("codex");
  expect((await settled(oauth)).state).toBe("done");
  first.resolve({ ...credential, access: "stale" });
  await first.promise;
  await Promise.resolve();
  expect(core.secrets.credential("codex")).toEqual(credential);
});

test("replacing an API key during login cancels the attempt and preserves the replacement", async () => {
  const result = Promise.withResolvers<OAuthCredential>();
  const { core, ledger, oauth } = setup(async () => result.promise);
  oauth.start("codex");
  core.secrets.put("codex", "owner-replacement");
  ledger.tx(() => ledger.emit({ type: "settings", settings: settingsView(core) }));
  result.resolve(credential);
  await result.promise;
  await Promise.resolve();
  expect(oauth.status("codex").state).toBe("cancelled");
  expect(core.secrets.get("codex")).toBe("owner-replacement");
});

test("failed login never returns provider error bodies or overwrites an existing key", async () => {
  const { core, oauth } = setup(async () => { throw new Error(`token response: ${JSON.stringify(credential)}`); });
  core.secrets.put("codex", "existing");
  oauth.start("codex");
  const status = await settled(oauth);
  expect(status.state).toBe("failed");
  expect(JSON.stringify(status)).not.toContain("private-");
  expect(core.secrets.get("codex")).toBe("existing");
});

test("device codes are only presented with the trusted OpenAI URL", async () => {
  const result = Promise.withResolvers<OAuthCredential>();
  const { oauth } = setup(async (interaction: ProviderAuthInteraction) => {
    interaction.notify({ type: "device_code", userCode: "secret-code", verificationUri: "https://attacker.invalid" });
    return result.promise;
  });
  oauth.start("codex");
  const status = await settled(oauth);
  expect(status.state).toBe("failed");
  expect(status.verificationUri).toBeNull();
});
