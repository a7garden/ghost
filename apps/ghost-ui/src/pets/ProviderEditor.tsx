import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Plus, Search } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, SegmentedControl, SelectField } from '../ui';
import type { ModelInfo, Provider, ProviderKind, ProviderPreset } from '@ghost/contract';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { ProviderModels } from './ProviderModels';
import { oauthName, OAUTH_KINDS } from '../uiText';
import '../features/ConnectionSetup.css';

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'zai', label: 'Z.AI' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'kimi', label: 'Kimi For Coding' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'xai', label: 'xAI' },
  { value: 'github_copilot', label: 'GitHub Copilot' },
  { value: 'openai_compatible', label: 'OpenAI 호환 서버' },
];

export interface ProviderDraft { id: string; kind: ProviderKind; name: string; baseUrl: string | null; models: ModelInfo[] }
/** Undefined keeps the stored credential, null removes it; login starts ChatGPT after saving. */
export interface ProviderSave { draft: ProviderDraft; apiKey?: string | null; login?: boolean }
export const providerKindLabel = (kind: ProviderKind) => KINDS.find(item => item.value === kind)?.label ?? kind;

export function ProviderEditor({ initial, presets, providerIds, busy, onClose, onSave }: {
  initial?: Provider;
  presets: ProviderPreset[];
  providerIds: string[];
  busy: boolean;
  onClose(): void;
  onSave(save: ProviderSave): Promise<void>;
}) {
  const [preset, setPreset] = useState<ProviderPreset>();
  const [query, setQuery] = useState('');
  const visible = presets.filter(item => `${item.name} ${providerKindLabel(item.kind)}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (initial) return <ProviderForm initial={initial} presets={presets} providerIds={providerIds} busy={busy} onClose={onClose} onSave={onSave}/>;
  return <section className="provider-enrollment" aria-label="제공자 추가"
    onKeyDown={event => { if (!preset && event.key === 'Escape' && !event.nativeEvent.isComposing && !busy) onClose(); }}>
    {!preset && <div className="provider-enrollment__tools">
      <div className="relative min-w-0 flex-1"><Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"/>
        <Input aria-label="제공자 검색" placeholder="제공자 검색" value={query} autoFocus onChange={event => setQuery(event.target.value)} className="pl-9"/>
      </div>
      <Button variant="ghost" type="button" disabled={busy} onClick={onClose}>취소</Button>
    </div>}
    <ul className="provider-enrollment__choices" aria-label="제공자 목록">
      {(preset ? [preset] : visible).map(item => <li key={item.id} className="provider-enrollment__choice">
        {preset ? <>
          <div className="provider-enrollment__identity">
            <span className="provider-enrollment__mark" aria-hidden="true">{item.name.slice(0, 1)}</span>
            <h3 className="m-0 text-ui font-semibold">{item.name}</h3>
          </div>
          <ProviderForm preset={item} presets={presets} providerIds={providerIds} busy={busy}
            onClose={onClose} onBack={() => setPreset(undefined)} onSave={onSave}/>
        </> : <button type="button" className="provider-enrollment__identity provider-enrollment__pick" disabled={busy} onClick={() => setPreset(item)}>
          <span className="provider-enrollment__mark" aria-hidden="true">{item.name.slice(0, 1)}</span>
          <span className="min-w-0 flex-1 font-medium">{item.name}</span><Plus size={15} className="flex-none text-ink-3" aria-hidden="true"/>
        </button>}
      </li>)}
    </ul>
    {!preset && !visible.length && <p className="m-0 text-caption text-ink-2">일치하는 제공자가 없습니다.</p>}
  </section>;
}

function ProviderForm({ initial, preset, presets, providerIds, busy, onClose, onBack, onSave }: {
  initial?: Provider; preset?: ProviderPreset; presets: ProviderPreset[]; providerIds: string[]; busy: boolean;
  onClose(): void; onBack?: () => void; onSave(save: ProviderSave): Promise<void>;
}) {
  const [method, setMethod] = useState<'api_key' | 'oauth'>(initial ? initial.authType === 'oauth' ? 'oauth' : 'api_key' : preset !== undefined && OAUTH_KINDS.has(preset.kind) ? 'oauth' : 'api_key');
  const [value, setValue] = useState<ProviderDraft>(() => {
    if (initial) return { id: initial.id, kind: initial.kind, name: initial.name, baseUrl: initial.baseUrl, models: (initial.configuredModels ?? initial.models).map(model => ({ ...model })) };
    const chosen = preset!;
    let id = chosen.id;
    for (let suffix = 2; providerIds.includes(id); suffix++) id = `${chosen.id}-${suffix}`;
    return { id, kind: chosen.kind, name: chosen.name, baseUrl: null, models: [] };
  });
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const surface = useRef<HTMLElement>(null);
  useEffect(() => { surface.current?.focus(); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || saving;
  const currentPreset = presets.find(item => item.kind === value.kind);
  const oauthAllowed = OAUTH_KINDS.has(value.kind) && value.baseUrl === null;
  const effectiveMethod = oauthAllowed ? method : 'api_key';
  const unchangedEndpoint = initial?.kind === value.kind && initial.baseUrl === value.baseUrl;
  const automatic = unchangedEndpoint && initial.automaticModels !== undefined
    ? initial.automaticModels
    : value.kind !== 'openai_compatible' && (value.baseUrl === null || value.baseUrl === currentPreset?.baseUrl);
  const manualModelIds = new Set(initial?.manualModelIds ?? []);
  const catalog = automatic
    ? unchangedEndpoint && initial.authType === effectiveMethod ? initial.models.filter(model => !manualModelIds.has(model.id)) : effectiveMethod === 'oauth' ? currentPreset?.oauthModels ?? [] : currentPreset?.models ?? []
    : [];
  const patch = (next: Partial<ProviderDraft>) => setValue(current => ({ ...current, ...next }));
  const chooseMethod = (next: 'api_key' | 'oauth') => {
    setMethod(next); setError(''); setRemoveKey(false);
    if (!initial) patch({ models: [] });
  };
  const save = async () => {
    if (locked) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)) { setError('제공자 ID는 소문자·숫자·하이픈·밑줄을 사용해 주세요.'); return; }
    if (!initial && providerIds.includes(value.id)) { setError('이미 등록된 제공자 ID입니다. 고급 설정에서 바꿔 주세요.'); return; }
    if (!value.name.trim()) { setError('이름을 입력해 주세요.'); return; }
    if (!automatic && !value.models.length) { setError('모델 ID를 한 개 이상 추가해 주세요.'); return; }
    if (value.kind === 'openai_compatible' && !value.baseUrl) { setError('서버 주소를 입력해 주세요.'); return; }
    const key = apiKey.trim();
    if (effectiveMethod === 'api_key' && !removeKey && !key && (!initial || initial.authType === 'oauth' || initial.kind !== value.kind)) { setError('API 키를 입력해 주세요.'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ draft: { ...value, name: value.name.trim() },
        ...(removeKey ? { apiKey: null } : effectiveMethod === 'api_key' && key ? { apiKey: key } : {}),
        ...(effectiveMethod === 'oauth' && !removeKey && initial?.authType !== 'oauth' ? { login: true } : {}),
      });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? `제공자 설정을 저장하지 못했습니다. ${reason.message}` : '제공자 설정을 저장하지 못했습니다.'); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <section className="setup-route provider-setup" aria-label={initial ? `${initial.name} 설정` : `${preset!.name} 연결`} tabIndex={-1} ref={surface}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && !locked) onClose(); }}>
    <form className="setup-route__body" aria-busy={locked} onSubmit={event => { event.preventDefault(); void save(); }}>
      {oauthAllowed && <SegmentedControl aria-label="인증 방법" value={method} onValueChange={chooseMethod}
        options={[{ value: 'oauth', label: `${oauthName(value.kind)} 구독`, disabled: locked }, { value: 'api_key', label: 'API 키', disabled: locked }]}/>}
      {value.kind === 'openai_compatible' && <FormField label="서버 주소">{control => <Input {...control} type="url" value={value.baseUrl ?? ''} placeholder="https://api.example.com/v1" required disabled={locked} onChange={event => patch({ baseUrl: event.target.value.trim() || null })}/>}</FormField>}
      {effectiveMethod === 'oauth'
        ? initial?.authType === 'oauth' && <p className="m-0 text-caption text-ink-2">저장된 {oauthName(value.kind)} 인증을 사용합니다.</p>
        : <div className="setup-route__credential"><FormField label={initial?.hasCredential ? '새 API 키' : 'API 키'} description={initial?.hasCredential && initial.authType !== 'oauth' ? '비워 두면 저장된 인증 정보를 유지합니다.' : undefined}>
          {control => <Input {...control} type="password" value={apiKey} maxLength={4096} autoComplete="new-password" disabled={locked || removeKey} onChange={event => setApiKey(event.target.value)}/>}
          </FormField>
          {currentPreset?.credentialUrl && <ExternalAnchor href={currentPreset.credentialUrl} target="_blank" rel="noopener noreferrer" className="setup-route__link">API 키 발급<ExternalLink size={12} aria-hidden="true"/></ExternalAnchor>}
        </div>}
      {automatic ? <details>
        <summary className="connection-advanced">모델 목록<span aria-hidden="true" className="fold-mark"/></summary>
        <ProviderModels catalog={catalog} selected={value.models} automatic disabled={locked} onChange={models => patch({ models })}/>
        <p className="m-0 text-caption text-ink-3">모델 목록은 자동으로 갱신됩니다. 사용 가능 여부는 계정의 권한을 따릅니다.</p>
      </details> : <ProviderModels catalog={catalog} selected={value.models} disabled={locked} onChange={models => patch({ models })}/>}
      <details className="border-t border-dashed border-line-strong pt-3">
        <summary className="connection-advanced">고급 설정<span aria-hidden="true" className="fold-mark"/></summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <div className="setup-route__pair">
            <FormField label="이름">{control => <Input {...control} value={value.name} maxLength={128} disabled={locked} onChange={event => patch({ name: event.target.value })}/>}</FormField>
            <FormField label="제공자 ID">{control => <Input {...control} value={value.id} maxLength={64} disabled={locked || !!initial} onChange={event => patch({ id: event.target.value.toLowerCase() })}/>}</FormField>
          </div>
          <FormField label="API 형식">{control => <SelectField {...control} label="API 형식" value={value.kind} disabled={locked} options={KINDS} onValueChange={kind => patch({ kind: kind as ProviderKind })}/>}</FormField>
          {value.kind !== 'openai_compatible' && <FormField label="서버 주소" description="비워 두면 제공자의 기본 주소를 사용합니다.">{control => <Input {...control} type="url" value={value.baseUrl ?? ''} placeholder={currentPreset?.baseUrl ?? ''} disabled={locked} onChange={event => patch({ baseUrl: event.target.value.trim() || null })}/>}</FormField>}
          {initial?.hasCredential && <label className="flex items-center gap-2.5 text-caption text-ink"><Checkbox checked={removeKey} disabled={locked} onCheckedChange={checked => setRemoveKey(checked === true)}/>저장된 인증 정보 삭제</label>}
        </div>
      </details>
      {error && <InlineError>{error}</InlineError>}
      <div className="setup-route__actions">
        {onBack && <Button variant="ghost" size="sm" type="button" className="mr-auto" disabled={locked} onClick={onBack}><ArrowLeft size={14}/>다른 제공자</Button>}
        <Button variant="ghost" type="button" disabled={locked} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={locked}>{saving ? '저장 중…' : effectiveMethod === 'oauth' && initial?.authType !== 'oauth' && !removeKey ? `${oauthName(value.kind)}로 로그인` : '저장'}</Button>
      </div>
    </form>
  </section>;
}
