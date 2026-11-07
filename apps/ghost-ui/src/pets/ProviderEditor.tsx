import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, SegmentedControl, SelectField } from '../ui';
import type { ModelInfo, Provider, ProviderKind, ProviderPreset } from '@ghost/contract';
import { Modal } from '../components/Modal';
import { ExternalAnchor } from '../components/ExternalAnchor';
import { ProviderModels } from './ProviderModels';

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'zai', label: 'Z.AI' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'google', label: 'Google Gemini' },
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
  if (initial || preset) return <ProviderForm initial={initial} preset={preset ?? presets.find(item => item.kind === initial?.kind)} presets={presets}
    providerIds={providerIds} busy={busy} onClose={onClose} onBack={initial ? undefined : () => setPreset(undefined)} onSave={onSave}/>;
  return <Modal title="제공자 추가" onClose={onClose} className="w-[min(480px,calc(100vw-2rem))] sm:max-w-[480px]">
    <div className="flex flex-col gap-3">
      <div className="relative"><Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"/>
        <Input aria-label="제공자 검색" placeholder="제공자 검색" value={query} onChange={event => setQuery(event.target.value)} className="pl-9"/>
      </div>
      <div className="flex flex-col" aria-label="제공자 목록">
        {visible.map(item => <button key={item.id} type="button" disabled={busy} onClick={() => setPreset(item)}
          className="flex min-h-16 items-center gap-3 rounded-control px-3 py-3 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 disabled:opacity-50">
          <span className="flex size-9 flex-none items-center justify-center rounded-control border border-line text-ui font-semibold text-ink" aria-hidden="true">{item.kind === 'openai_compatible' ? '+' : item.name.slice(0, 1)}</span>
          <span className="min-w-0 flex-1"><span className="block text-ui font-semibold text-ink">{item.name}</span>
            <span className="block text-caption text-ink-3">{item.kind === 'openai' ? 'ChatGPT 구독 · API 키' : item.kind === 'openai_compatible' ? '주소와 모델 직접 설정' : 'API 키'}</span>
          </span><ChevronRight size={15} className="flex-none text-ink-3" aria-hidden="true"/>
        </button>)}
      </div>
      {!visible.length && <p className="m-0 px-3 py-4 text-ui text-ink-3">일치하는 제공자가 없습니다.</p>}
    </div>
  </Modal>;
}

function ProviderForm({ initial, preset, presets, providerIds, busy, onClose, onBack, onSave }: {
  initial?: Provider; preset?: ProviderPreset; presets: ProviderPreset[]; providerIds: string[]; busy: boolean;
  onClose(): void; onBack?: () => void; onSave(save: ProviderSave): Promise<void>;
}) {
  const [method, setMethod] = useState<'api_key' | 'oauth'>(initial ? initial.authType === 'oauth' ? 'oauth' : 'api_key' : preset?.kind === 'openai' ? 'oauth' : 'api_key');
  const [value, setValue] = useState<ProviderDraft>(() => {
    if (initial) return { id: initial.id, kind: initial.kind, name: initial.name, baseUrl: initial.baseUrl, models: initial.models.map(model => ({ ...model })) };
    const chosen = preset!;
    let id = chosen.id;
    for (let suffix = 2; providerIds.includes(id); suffix++) id = `${chosen.id}-${suffix}`;
    const models = method === 'oauth' ? chosen.oauthModels : chosen.models;
    const recommended = method === 'oauth' ? chosen.recommendedOAuthModelId : chosen.recommendedModelId;
    return { id, kind: chosen.kind, name: chosen.name, baseUrl: null, models: models.filter(model => model.id === recommended).map(model => ({ ...model })) };
  });
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const locked = busy || saving;
  const currentPreset = presets.find(item => item.kind === value.kind);
  const oauthAllowed = value.kind === 'openai' && value.baseUrl === null;
  const effectiveMethod = oauthAllowed ? method : 'api_key';
  const catalog = value.baseUrl === null ? effectiveMethod === 'oauth' ? currentPreset?.oauthModels ?? [] : currentPreset?.models ?? [] : [];
  const patch = (next: Partial<ProviderDraft>) => setValue(current => ({ ...current, ...next }));
  const chooseMethod = (next: 'api_key' | 'oauth') => {
    setMethod(next); setError(''); setRemoveKey(false);
    if (!initial && currentPreset) {
      const source = next === 'oauth' ? currentPreset.oauthModels : currentPreset.models;
      const recommended = next === 'oauth' ? currentPreset.recommendedOAuthModelId : currentPreset.recommendedModelId;
      patch({ models: source.filter(model => model.id === recommended).map(model => ({ ...model })) });
    }
  };
  const save = async () => {
    if (locked) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)) { setError('제공자 ID는 소문자·숫자·하이픈·밑줄을 사용해 주세요.'); return; }
    if (!initial && providerIds.includes(value.id)) { setError('이미 등록된 제공자 ID입니다. 고급 설정에서 바꿔 주세요.'); return; }
    if (!value.name.trim()) { setError('이름을 입력해 주세요.'); return; }
    if (!value.models.length) { setError('사용할 모델을 한 개 이상 선택해 주세요.'); return; }
    if (value.kind === 'openai_compatible' && !value.baseUrl) { setError('서버 주소를 입력해 주세요.'); return; }
    const key = apiKey.trim();
    if (effectiveMethod === 'api_key' && !removeKey && !key && (!initial || initial.authType === 'oauth' || initial.kind !== value.kind)) { setError('API 키를 입력해 주세요.'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ draft: { ...value, name: value.name.trim() },
        ...(removeKey ? { apiKey: null } : effectiveMethod === 'api_key' && key ? { apiKey: key } : {}),
        ...(effectiveMethod === 'oauth' && !removeKey && initial?.authType !== 'oauth' ? { login: true } : {}),
      });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.'); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <Modal title={initial ? `${initial.name} 설정` : preset!.name} onClose={() => !locked && onClose()} className="w-[min(560px,calc(100vw-2rem))] sm:max-w-[560px]">
    <form className="flex max-h-[calc(100dvh-8rem)] min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      {onBack && <Button variant="ghost" size="sm" type="button" className="self-start" disabled={locked} onClick={onBack}><ArrowLeft size={14}/>다른 제공자</Button>}
      {oauthAllowed && <SegmentedControl aria-label="인증 방법" value={method} onValueChange={chooseMethod}
        options={[{ value: 'oauth', label: 'ChatGPT 구독', disabled: locked }, { value: 'api_key', label: 'API 키', disabled: locked }]}/>}
      {effectiveMethod === 'oauth'
        ? <p className="m-0 text-ui text-ink-2">{initial?.authType === 'oauth' ? '저장된 ChatGPT 인증을 사용합니다.' : '저장 후 인증 페이지에서 ChatGPT 계정으로 로그인합니다.'}</p>
        : <FormField label={initial?.hasCredential ? '새 API 키' : 'API 키'} description={initial?.hasCredential && initial.authType !== 'oauth' ? '비워 두면 저장된 인증 정보를 유지합니다.' : '키는 호스트에만 저장되며 다시 표시되지 않습니다.'}>
          {control => <div className="flex flex-col gap-2"><Input {...control} type="password" value={apiKey} maxLength={4096} autoComplete="off" disabled={locked || removeKey} onChange={event => setApiKey(event.target.value)}/>
            {currentPreset?.credentialUrl && <ExternalAnchor href={currentPreset.credentialUrl} target="_blank" rel="noopener noreferrer" className="flex w-fit items-center gap-1 text-caption text-ink-2 underline underline-offset-4">API 키 발급<ExternalLink size={12} aria-hidden="true"/></ExternalAnchor>}
          </div>}
        </FormField>}
      {value.kind === 'openai_compatible' && <FormField label="서버 주소">{control => <Input {...control} type="url" value={value.baseUrl ?? ''} placeholder="https://api.example.com/v1" required disabled={locked} onChange={event => patch({ baseUrl: event.target.value.trim() || null })}/>}</FormField>}
      <ProviderModels catalog={catalog} selected={value.models} disabled={locked} onChange={models => patch({ models })}/>
      {catalog.length > 0 && <p className="m-0 text-caption text-ink-3">기본 모델 목록입니다. 사용 가능 여부는 계정의 권한을 따릅니다.</p>}
      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-caption font-medium text-ink-2">고급 설정</summary>
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="이름">{control => <Input {...control} value={value.name} maxLength={128} disabled={locked} onChange={event => patch({ name: event.target.value })}/>}</FormField>
            <FormField label="제공자 ID">{control => <Input {...control} value={value.id} maxLength={64} disabled={locked || !!initial} onChange={event => patch({ id: event.target.value.toLowerCase() })}/>}</FormField>
          </div>
          <FormField label="API 형식">{control => <SelectField {...control} label="API 형식" value={value.kind} disabled={locked} options={KINDS} onValueChange={kind => patch({ kind: kind as ProviderKind })}/>}</FormField>
          {value.kind !== 'openai_compatible' && <FormField label="서버 주소" description="비워 두면 제공자의 기본 주소를 사용합니다.">{control => <Input {...control} type="url" value={value.baseUrl ?? ''} placeholder={currentPreset?.baseUrl ?? ''} disabled={locked} onChange={event => patch({ baseUrl: event.target.value.trim() || null })}/>}</FormField>}
          {initial?.hasCredential && <label className="flex items-center gap-2.5 text-caption text-ink"><Checkbox checked={removeKey} disabled={locked} onCheckedChange={checked => setRemoveKey(checked === true)}/>저장된 인증 정보 삭제</label>}
        </div>
      </details>
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-none justify-end gap-2 border-t border-line pt-3">
        <Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={locked}>{saving ? '저장 중…' : effectiveMethod === 'oauth' && initial?.authType !== 'oauth' && !removeKey ? 'ChatGPT로 로그인' : '저장'}</Button>
      </div>
    </form>
  </Modal>;
}
