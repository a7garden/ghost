import { LocalAuthImport, parse, type LocalAuthResult, type LocalAuthSource } from "@ghost/contract";
import { settingsView } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { conflict, invalid, notFound } from "../core/errors.ts";
import type { LocalAuth, LocalAuthEntry } from "../integrations/local-auth.ts";

/**
 * Where an imported credential goes. An existing provider qualifies only if it talks to the vendor's own server:
 * a key issued for the official endpoint must never be sent to a proxy the owner pointed a provider at. The
 * credential-less provider wins, so an import does not replace a working key when an empty slot exists.
 */
function targetFor(core: Core, entry: LocalAuthEntry): LocalAuthSource["target"] {
  const preset = core.catalog.presets.find(item => item.kind === entry.kind && item.kind !== "openai_compatible");
  if (!preset) throw invalid("이 제공자는 Ghost에서 지원하지 않습니다.");
  const providers = core.ledger.providers();
  const matches = providers.filter(provider => provider.kind === entry.kind
    && (provider.baseUrl === null || (entry.authType === "api_key" && provider.baseUrl === preset.baseUrl)));
  const existing = matches.find(provider => !core.secrets.has(provider.id)) ?? matches[0];
  if (existing) return { providerId: existing.id, name: existing.name, exists: true, hasCredential: core.secrets.has(existing.id) };
  let providerId = preset.id;
  for (let suffix = 2; providers.some(provider => provider.id === providerId); suffix++) providerId = `${preset.id}-${suffix}`;
  return { providerId, name: preset.name, exists: false, hasCredential: false };
}

export function localAuthSources(core: Core, auth: LocalAuth): LocalAuthSource[] {
  return auth.scan().map(entry => {
    const { credential: _secret, ...view } = entry;
    return { ...view, target: targetFor(core, entry) };
  });
}

/** Copies the credential into Ghost's secret store; the other agent keeps its own and is never modified. */
export async function importLocalAuth(core: Core, auth: LocalAuth, input: LocalAuthImport): Promise<LocalAuthResult> {
  const entry = auth.find(input.sourceId);
  if (!entry) throw notFound("가져올 인증 정보를 찾지 못했습니다. 목록을 다시 불러와 주세요.");
  const target = targetFor(core, entry);
  if (target.hasCredential && input.replace !== true) throw conflict(`${target.name}에 이미 인증 정보가 있습니다. 바꾸려면 확인이 필요합니다.`);
  const { credential } = entry;
  if (credential.type === "api_key") {
    if (!credential.key) throw invalid("API 키를 읽지 못했습니다.");
    core.secrets.put(target.providerId, credential.key);
  } else if (await core.secrets.modify(target.providerId, async () => credential) !== credential) throw conflict("가져오는 동안 인증 정보가 바뀌었습니다. 다시 시도해 주세요.");
  if (target.exists && !core.ledger.providers().some(provider => provider.id === target.providerId)) {
    core.secrets.put(target.providerId, null);
    throw conflict(`${target.name} 제공자가 가져오는 동안 삭제되었습니다.`);
  }
  core.ledger.tx(() => {
    if (!target.exists) core.ledger.putProvider({ id: target.providerId, kind: entry.kind, name: target.name, baseUrl: null, models: [] });
    core.ledger.emit({ type: "settings", settings: settingsView(core) });
  });
  return { providerId: target.providerId, created: !target.exists };
}

/** Owner and paired-device HTTP only: Ghost's tool registry has no path to another agent's credentials. */
export async function serveLocalAuth(request: Request, path: string, core: Core, auth: LocalAuth): Promise<unknown> {
  if (path === "/api/providers/local-auth" && request.method === "GET") return localAuthSources(core, auth);
  if (path === "/api/providers/local-auth/import" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => { throw invalid("malformed JSON body"); });
    return importLocalAuth(core, auth, parse(LocalAuthImport, body));
  }
  throw notFound("local-auth route not found");
}
