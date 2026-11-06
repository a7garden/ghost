import { useEffect, useId, useRef, useState } from 'react';
import { Cpu, Image, KeyRound, Terminal } from 'lucide-react';
import { Badge, Button, Checkbox, GSettingsGroup, GSettingsRow, InlineError, Input, SelectField } from '@garden/ui';
import { Modal } from '../components/Modal';
import { ImageComposer } from './ImageComposer';

type Pair = { ghost_id: string; conversation_id: string };
type Selection = { provider: string; model: string; effort: string };
type Provider = { id: string; name: string; auth: string; models: string[]; efforts: string[]; default_model: string | null; default_effort: string; image: boolean; image_note?: string };
type OrchestraProfile = { routes: Record<string, Selection>; reviewer: Selection | null };
type Configuration = {
  settings: { version: number; default: Selection; conversations: Record<string, Selection>; external_grants: Record<string, string[]>; credentials: Record<string, boolean>; image_provider: string; orchestra?: Record<string, { version: number; profile: OrchestraProfile }> };
  providers: Provider[];
};

export async function inferenceRequest(body?: Record<string, unknown>): Promise<Configuration> {
  const signal = AbortSignal.timeout(15000);
  const bootstrapResponse = await fetch('/ghost-api/bootstrap', { cache: 'no-store', signal });
  if (!bootstrapResponse.ok) throw new Error('연결된 Ghost 호스트가 필요합니다.');
  const bootstrap = await bootstrapResponse.json();
  if (bootstrap.mode !== 'live' || !bootstrap.csrf) throw new Error('연결된 Ghost 호스트가 필요합니다.');
  const response = await fetch('/ghost-api/inference/settings', {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Ghost-UI-CSRF': bootstrap.csrf },
    ...(body ? { body: JSON.stringify(body) } : {}), signal,
  });
  const value = await response.json();
  if (!response.ok || value.ok !== true || !value.settings || !Array.isArray(value.providers)) {
    throw new Error(typeof value.error === 'string' ? value.error : body ? '모델 설정을 저장하지 못했습니다.' : '모델 설정을 불러오지 못했습니다.');
  }
  return value;
}

const effortNames: Record<string, string> = { off: '사용 안 함', low: '빠르게', medium: '균형', high: '깊게', xhigh: '더 깊게', max: '최대' };
const effortLabel = (effort: string) => effortNames[effort] ?? effort;
type Status = { label: string; tone: 'neutral' | 'info' | 'warning' | 'success'; detail: string };
// Radix Select는 빈 값을 항목으로 가질 수 없으므로 '끄기' 선택값을 치환한다.
const REVIEW_OFF = '__off__';

export function inferenceProviderStatus(provider: Pick<Provider, 'id' | 'auth' | 'models'>, credentialPresent: boolean): Status {
  if (provider.auth === 'api_key') {
    return credentialPresent
      ? { label: '키 등록됨', tone: 'success', detail: '응답을 생성할 때 계정 권한을 확인합니다.' }
      : { label: '인증 필요', tone: 'warning', detail: 'API 키를 등록해 사용하세요.' };
  }
  if (provider.auth === 'codex_oauth') return { label: 'CLI 로그인', tone: 'info', detail: '이 Mac의 Codex CLI 로그인을 사용합니다.' };
  if (provider.id === 'local') {
    return provider.models.length
      ? { label: '로컬 설정됨', tone: 'neutral', detail: provider.models.join(', ') }
      : { label: '로컬 미설정', tone: 'warning', detail: '호스트에 대화용 로컬 모델이 설정되어 있지 않습니다.' };
  }
  return { label: '카탈로그', tone: 'neutral', detail: '' };
}

const statusBadge: Record<Status['tone'], 'default' | 'success' | 'warning' | 'outline'> = { neutral: 'outline', info: 'default', warning: 'warning', success: 'success' };

type InferenceProps = { pair?: Pair; primary?: boolean; publicOnly?: boolean; disabled?: boolean; connected?: boolean };
export function InferenceSettings({ pair, ...props }: InferenceProps) {
  // Project registry entries onto the two fields accepted by inference requests.
  const target: Pair | undefined = pair && { ghost_id: pair.ghost_id, conversation_id: pair.conversation_id };
  const pairKey = target ? `${target.ghost_id}/${target.conversation_id}` : '';
  // Bind drafts, consent and request results to one Ghost and conversation.
  return <InferencePanel key={pairKey} {...props} pair={target} pairKey={pairKey}/>;
}

function InferencePanel({ pair, pairKey, primary = false, publicOnly = false, disabled = false, connected = true }: InferenceProps & { pairKey: string }) {
  const [data, setData] = useState<Configuration>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [draft, setDraft] = useState<Selection>(), [allow, setAllow] = useState(false);
  const [keyEditor, setKeyEditor] = useState<{ provider: string; value: string }>();
  const [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [reviewProvider, setReviewProvider] = useState<string>();
  const consentId = useId();
  const saving = useRef(false);
  const refresh = () => {
    setData(undefined); setDraft(undefined); setAllow(false); setReviewProvider(undefined); setKeyEditor(undefined); setError(''); setNotice('');
    setReload(value => value + 1);
  };
  useEffect(() => {
    if (!connected) { setAllow(false); setKeyEditor(undefined); return; }
    let current = true;
    setData(undefined); setDraft(undefined); setAllow(false); setError(''); setNotice('');
    void inferenceRequest().then(next => {
      if (!current) return;
      setData(next);
      setDraft(next.settings.conversations[pairKey] ?? next.settings.default);
    }).catch(reason => {
      if (current) setError(reason instanceof Error ? reason.message : '설정을 불러오지 못했습니다.');
    });
    return () => { current = false; };
  }, [connected, pairKey, reload]);
  useEffect(() => { if (disabled) setAllow(false); }, [disabled]);

  const locked = disabled || !connected || busy || Boolean(error);
  const save = async (body: Record<string, unknown>, message: string) => {
    if (!data || locked || saving.current) return;
    saving.current = true;
    setBusy(true); setNotice('');
    try {
      const next = await inferenceRequest({ version: data.settings.version, ...body });
      setData(next);
      if (body.operation === 'set_api_key') setKeyEditor(undefined);
      if (body.operation === 'set_orchestra') setReviewProvider(undefined);
      if (body.operation === 'select' || body.operation === 'set_default') {
        setDraft(next.settings.conversations[pairKey] ?? next.settings.default);
        setAllow(false);
      }
      setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장 결과를 확인하지 못했습니다.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const selected = data && (data.settings.conversations[pairKey] ?? data.settings.default);
  const provider = data?.providers.find(item => item.id === draft?.provider);
  const registered = provider?.auth !== 'api_key' || data?.settings.credentials[provider.id] === true;
  const granted = Boolean(pair && !publicOnly && draft && data?.settings.external_grants[pairKey]?.includes(draft.provider));
  const needsGrant = Boolean(pair && !publicOnly && draft?.provider !== 'local' && !granted);
  const usableSelection = Boolean(draft && !(publicOnly && draft.provider === 'local') && provider?.models.includes(draft.model) && provider.efforts.includes(draft.effort));
  const imageProviders = data?.providers.filter(item => item.image) ?? [];
  const orchestra = data?.settings.orchestra?.[pairKey]?.profile;
  const savedReviewer = orchestra?.reviewer?.provider ?? '';
  const reviewerOptions = data?.providers.filter(item => selected?.provider !== 'local' && item.id !== selected?.provider
    && ['zai-coding', 'minimax'].includes(item.id) && item.default_model && data.settings.credentials[item.id]) ?? [];
  const proposedReviewer = reviewerOptions.find(item => item.id === reviewProvider);

  const fields = <>
    {!connected && <p className="m-0 text-ui text-ink-2" role="status">호스트에 연결하면 설정을 변경할 수 있습니다.</p>}
    {connected && !data && !error && <p className="m-0 text-ui text-ink-2" role="status">모델 설정을 불러오는 중…</p>}
    {data && draft && <>
      <section aria-label="대화 모델" className="min-w-0">
        <GSettingsGroup title={pair ? <span className="sr-only">대화 모델</span> : '기본 대화 모델'}>
          <GSettingsRow label="제공자">
            <SelectField label="대화 제공자" disabled={locked} value={draft.provider} onValueChange={value => {
              const next = data.providers.find(item => item.id === value);
              if (!next?.default_model) return;
              setDraft({ provider: next.id, model: next.default_model, effort: next.default_effort });
              setAllow(false);
            }} options={[
              ...(!provider ? [{ value: draft.provider, label: `${draft.provider} · 사용 불가` }] : []),
              ...data.providers.map(item => ({ value: item.id, label: item.name, disabled: !item.models.length || publicOnly && item.id === 'local' })),
            ]}/>
          </GSettingsRow>
          <GSettingsRow label="모델">
            <SelectField label="Ghost 모델" disabled={locked || !provider?.models.length} value={draft.model} onValueChange={model => setDraft({ ...draft, model })} options={[
              ...(!provider?.models.includes(draft.model) ? [{ value: draft.model, label: `${draft.model} · 사용 불가` }] : []),
              ...(provider?.models.map(model => ({ value: model, label: model })) ?? []),
            ]}/>
          </GSettingsRow>
          <GSettingsRow label="추론 수준">
            <SelectField label="추론 수준" disabled={locked || !provider?.efforts.length} value={draft.effort} onValueChange={effort => setDraft({ ...draft, effort })} options={[
              ...(!provider?.efforts.includes(draft.effort) ? [{ value: draft.effort, label: `${effortLabel(draft.effort)} · 사용 불가` }] : []),
              ...(provider?.efforts.map(effort => ({ value: effort, label: effortLabel(effort) })) ?? []),
            ]}/>
          </GSettingsRow>
          {needsGrant && <div className="flex items-start gap-2.5 px-4 py-3 text-ui text-ink">
            <Checkbox id={consentId} checked={allow} disabled={locked} onCheckedChange={value => setAllow(value === true)}/>
            <label htmlFor={consentId} className="min-w-0 [overflow-wrap:anywhere]">이 대화의 기존 기록과 새 메시지를 {provider?.name ?? draft.provider}에 전송하는 것을 허용합니다.</label>
          </div>}
          {granted && <p className="m-0 px-4 pb-3 text-caption text-ink-3">이 대화의 {provider?.name ?? draft.provider} 외부 처리가 허용돼 있습니다.</p>}
          {!registered && <p className="m-0 px-4 pb-3 text-caption text-ink-3">먼저 제공자의 API 키를 등록하세요.</p>}
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Button type="button" disabled={locked || !usableSelection || !registered || (needsGrant && !allow)} onClick={() => void save(
              pair ? { operation: 'select', ...pair, selection: draft, ...(!publicOnly ? { allow_external: allow } : {}) } : { operation: 'set_default', selection: draft },
              pair ? '이 대화의 모델을 저장했습니다.' : '기본 대화 모델을 저장했습니다.',
            )}>{busy ? '저장 중…' : pair ? '이 대화에 적용' : '기본 모델 저장'}</Button>
          </div>
        </GSettingsGroup>
      </section>
      {!pair && <>
        <section aria-label="추론 제공자" className="min-w-0">
          <GSettingsGroup title="제공자">
            {data.providers.map(item => {
              const status = inferenceProviderStatus(item, data.settings.credentials[item.id] === true);
              const editing = keyEditor?.provider === item.id;
              const Icon = item.auth === 'api_key' ? KeyRound : item.auth === 'codex_oauth' ? Terminal : Cpu;
              return <GSettingsRow key={item.id} label={<span className="flex min-w-0 items-center gap-2.5">
                <Icon size={17} aria-hidden="true" className="flex-none"/>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">{item.name}<Badge variant={statusBadge[status.tone]}>{status.label}</Badge></span>
                  {status.detail && <span className="mt-1 block text-caption font-normal text-ink-3 [overflow-wrap:anywhere]">{status.detail}</span>}
                </span>
              </span>}>
                <div className="flex min-w-0 flex-col items-start gap-2">
                  {item.auth === 'api_key' && <Button type="button" variant="outline" disabled={locked} aria-expanded={editing} aria-label={`${item.name} API 키 ${editing ? '닫기' : data.settings.credentials[item.id] ? '변경' : '등록'}`}
                    onClick={() => setKeyEditor(editing ? undefined : { provider: item.id, value: '' })}>
                    {editing ? '닫기' : data.settings.credentials[item.id] ? '키 변경' : '키 등록'}
                  </Button>}
                  {editing && <form className="flex w-full min-w-0 flex-wrap items-center gap-2" onSubmit={event => {
                    event.preventDefault();
                    if (keyEditor.value.length >= 8 && !/\s/u.test(keyEditor.value)) void save({ operation: 'set_api_key', provider: item.id, api_key: keyEditor.value }, `${item.name} API 키를 저장했습니다.`);
                  }}>
                    <Input type="password" autoComplete="off" autoFocus required maxLength={4096} aria-label={`${item.name} API 키`} placeholder="API 키" value={keyEditor.value} disabled={locked} className="min-w-[10rem] flex-1"
                      onChange={event => setKeyEditor({ provider: item.id, value: event.target.value })}/>
                    <Button type="submit" disabled={locked || keyEditor.value.length < 8 || /\s/u.test(keyEditor.value)}>키 저장</Button>
                  </form>}
                </div>
              </GSettingsRow>;
            })}
          </GSettingsGroup>
        </section>
        <section aria-label="이미지 생성" className="min-w-0">
          <GSettingsGroup title="이미지 생성">
            <GSettingsRow label={<span className="flex min-w-0 items-center gap-2.5">
              <Image size={17} aria-hidden="true" className="flex-none"/>
              <span className="min-w-0">기본 제공자
                <span className="mt-1 block text-caption font-normal text-ink-3 [overflow-wrap:anywhere]">{imageProviders.find(item => item.id === data.settings.image_provider)?.image_note ?? 'Codex는 CLI 로그인, MiniMax는 등록된 API 키를 사용합니다.'}</span>
              </span>
            </span>}>
              <SelectField className="max-w-[15rem]" label="이미지 제공자" value={data.settings.image_provider} disabled={locked || !imageProviders.length} onValueChange={value => void save({ operation: 'image_provider', provider: value }, '이미지 제공자를 저장했습니다.')} options={[
                ...(!imageProviders.some(item => item.id === data.settings.image_provider) ? [{ value: data.settings.image_provider, label: `${data.settings.image_provider} · 사용 불가` }] : []),
                ...imageProviders.map(item => ({ value: item.id, label: item.name })),
              ]}/>
            </GSettingsRow>
          </GSettingsGroup>
        </section>
      </>}
      {pair && primary && (reviewerOptions.length > 0 || savedReviewer) && <section aria-label="독립 리뷰" className="min-w-0">
        <GSettingsGroup title={<span className="sr-only">독립 리뷰</span>}>
          <GSettingsRow label="독립 리뷰">
            <SelectField label="독립 리뷰" value={(reviewProvider ?? savedReviewer) || REVIEW_OFF} disabled={locked} onValueChange={value => setReviewProvider(value === REVIEW_OFF ? '' : value)} options={[
              { value: REVIEW_OFF, label: '자동 리뷰 끄기' },
              ...(savedReviewer && !reviewerOptions.some(item => item.id === savedReviewer) ? [{ value: savedReviewer, label: `${savedReviewer} · 사용 불가`, disabled: true }] : []),
              ...reviewerOptions.map(item => ({ value: item.id, label: item.name })),
            ]}/>
          </GSettingsRow>
          <p className="m-0 px-4 py-3 text-caption text-ink-3">새 공개 업무의 요구사항과 산출물을 선택한 제공자에게 보내 독립 리뷰를 받습니다.</p>
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Button type="button" variant="outline" disabled={locked || reviewProvider === undefined || reviewProvider === savedReviewer
              || (reviewProvider !== '' && !proposedReviewer)} onClick={() => void save({
                operation: 'set_orchestra', ...pair, profile: { routes: orchestra?.routes ?? {},
                  reviewer: proposedReviewer?.default_model ? { provider: proposedReviewer.id, model: proposedReviewer.default_model,
                    effort: proposedReviewer.default_effort } : null },
              }, proposedReviewer ? '새 공개 업무의 독립 리뷰를 켰습니다.' : '독립 리뷰 권한을 해제했습니다.')}>
              {proposedReviewer ? '전송 허용 및 켜기' : '독립 리뷰 끄기'}
            </Button>
          </div>
        </GSettingsGroup>
      </section>}
      {pair && <fieldset className="m-0 flex min-w-0 flex-col" disabled={locked}><ImageComposer pair={pair}/></fieldset>}
    </>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {error && (disabled || busy || !connected
      ? <InlineError>{error}</InlineError>
      : <InlineError onRetry={refresh} retryLabel="다시 확인">{error}</InlineError>)}
  </>;

  return <section className="flex min-w-0 flex-col gap-6" aria-label={pair ? '이 대화의 모델' : '추론 설정'}>
    {pair ? <>
      <Button type="button" variant="outline" className="max-w-full" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <Cpu size={14}/><span className="min-w-0 truncate">{selected ? `${selected.model} · ${effortLabel(selected.effort)}` : '대화 모델'}</span>
      </Button>
      {settingsOpen && <Modal title="대화 모델" onClose={() => {
        if (saving.current) return;
        setSettingsOpen(false);
        setAllow(false);
        setReviewProvider(undefined);
      }}><div className="flex flex-col gap-5">{fields}</div></Modal>}
    </> : fields}
  </section>;
}
