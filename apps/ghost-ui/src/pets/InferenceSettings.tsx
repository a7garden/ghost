import { useEffect, useRef, useState } from 'react';
import { Cpu, Image, KeyRound, Terminal } from 'lucide-react';
import { Modal } from '../components/Modal';
import { ImageComposer } from './ImageComposer';
import '../features/connections.css';

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

type InferenceProps = { pair?: Pair; primary?: boolean; disabled?: boolean; connected?: boolean };
export function InferenceSettings({ pair, ...props }: InferenceProps) {
  // Project registry entries onto the two fields accepted by inference requests.
  const target: Pair | undefined = pair && { ghost_id: pair.ghost_id, conversation_id: pair.conversation_id };
  const pairKey = target ? `${target.ghost_id}/${target.conversation_id}` : '';
  // Bind drafts, consent and request results to one Ghost and conversation.
  return <InferencePanel key={pairKey} {...props} pair={target} pairKey={pairKey}/>;
}

function InferencePanel({ pair, pairKey, primary = false, disabled = false, connected = true }: InferenceProps & { pairKey: string }) {
  const [data, setData] = useState<Configuration>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [draft, setDraft] = useState<Selection>(), [allow, setAllow] = useState(false);
  const [keyEditor, setKeyEditor] = useState<{ provider: string; value: string }>();
  const [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [reviewProvider, setReviewProvider] = useState<string>();
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
  const granted = Boolean(pair && draft && data?.settings.external_grants[pairKey]?.includes(draft.provider));
  const needsGrant = Boolean(pair && draft?.provider !== 'local' && !granted);
  const usableSelection = Boolean(draft && provider?.models.includes(draft.model) && provider.efforts.includes(draft.effort));
  const imageProviders = data?.providers.filter(item => item.image) ?? [];
  const orchestra = data?.settings.orchestra?.[pairKey]?.profile;
  const savedReviewer = orchestra?.reviewer?.provider ?? '';
  const reviewerOptions = data?.providers.filter(item => selected?.provider !== 'local' && item.id !== selected?.provider
    && ['zai-coding', 'minimax'].includes(item.id) && item.default_model && data.settings.credentials[item.id]) ?? [];
  const proposedReviewer = reviewerOptions.find(item => item.id === reviewProvider);

  const fields = <>
    {!connected && <p className="connection-message" role="status">호스트에 연결하면 설정을 변경할 수 있습니다.</p>}
    {connected && !data && !error && <p className="connection-message" role="status">모델 설정을 불러오는 중…</p>}
    {data && draft && <>
      <section className={pair ? 'inference-pair-body' : 'connection-section'} aria-label="대화 모델">
        {!pair && <div className="connection-heading"><h2>기본 대화 모델</h2></div>}
        <div className={pair ? 'inference-pair-settings' : 'connection-surface inference-default'}>
          <div className="inference-fields">
            <label>제공자<select aria-label="대화 제공자" disabled={locked} value={draft.provider} onChange={event => {
              const next = data.providers.find(item => item.id === event.target.value);
              if (!next?.default_model) return;
              setDraft({ provider: next.id, model: next.default_model, effort: next.default_effort });
              setAllow(false);
            }}>
              {!provider && <option value={draft.provider}>{draft.provider} · 사용 불가</option>}
              {data.providers.map(item => <option value={item.id} key={item.id} disabled={!item.models.length}>{item.name}</option>)}
            </select></label>
            <label>모델<select aria-label="Ghost 모델" value={draft.model} disabled={locked || !provider?.models.length} onChange={event => setDraft({ ...draft, model: event.target.value })}>
              {!provider?.models.includes(draft.model) && <option value={draft.model}>{draft.model} · 사용 불가</option>}
              {provider?.models.map(model => <option key={model}>{model}</option>)}
            </select></label>
            <label>추론 수준<select aria-label="추론 수준" value={draft.effort} disabled={locked || !provider?.efforts.length} onChange={event => setDraft({ ...draft, effort: event.target.value })}>
              {!provider?.efforts.includes(draft.effort) && <option value={draft.effort}>{effortLabel(draft.effort)} · 사용 불가</option>}
              {provider?.efforts.map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
            </select></label>
          </div>
          {needsGrant && <label className="inference-consent"><input type="checkbox" checked={allow} disabled={locked} onChange={event => setAllow(event.target.checked)}/>이 대화의 기존 기록과 새 메시지를 {provider?.name ?? draft.provider}에 전송하는 것을 허용합니다.</label>}
          {granted && <p className="field-help">이 대화의 {provider?.name ?? draft.provider} 외부 처리가 허용돼 있습니다.</p>}
          {!registered && <p className="field-help">먼저 제공자의 API 키를 등록하세요.</p>}
          <div className="inference-footer">
            <button className="button primary" type="button" disabled={locked || !usableSelection || !registered || (needsGrant && !allow)} onClick={() => void save(
              pair ? { operation: 'select', ...pair, selection: draft, allow_external: allow } : { operation: 'set_default', selection: draft },
              pair ? '이 대화의 모델을 저장했습니다.' : '기본 대화 모델을 저장했습니다.',
            )}>{busy ? '저장 중…' : pair ? '이 대화에 적용' : '기본 모델 저장'}</button>
          </div>
        </div>
      </section>
      {!pair && <>
        <section className="connection-section" aria-label="추론 제공자">
          <div className="connection-heading"><h2>제공자</h2></div>
          <ul className="connection-surface connection-list" role="list">
            {data.providers.map(item => {
              const status = inferenceProviderStatus(item, data.settings.credentials[item.id] === true);
              const editing = keyEditor?.provider === item.id;
              const Icon = item.auth === 'api_key' ? KeyRound : item.auth === 'codex_oauth' ? Terminal : Cpu;
              return <li className="connection-row connection-provider" key={item.id}>
                <span className="connection-icon"><Icon size={17} aria-hidden="true"/></span>
                <div className="connection-row-copy"><div className="connection-row-title"><h3>{item.name}</h3><span className="connection-status" data-tone={status.tone}>{status.label}</span></div>
                  {status.detail && <p>{status.detail}</p>}
                </div>
                {item.auth === 'api_key' && <button type="button" className="button secondary" disabled={locked} aria-expanded={editing} aria-label={`${item.name} API 키 ${editing ? '닫기' : data.settings.credentials[item.id] ? '변경' : '등록'}`}
                  onClick={() => setKeyEditor(editing ? undefined : { provider: item.id, value: '' })}>
                  {editing ? '닫기' : data.settings.credentials[item.id] ? '키 변경' : '키 등록'}
                </button>}
                {editing && <form className="inference-key-form" onSubmit={event => {
                  event.preventDefault();
                  if (keyEditor.value.length >= 8 && !/\s/u.test(keyEditor.value)) void save({ operation: 'set_api_key', provider: item.id, api_key: keyEditor.value }, `${item.name} API 키를 저장했습니다.`);
                }}>
                  <input type="password" autoComplete="off" autoFocus required maxLength={4096} aria-label={`${item.name} API 키`} placeholder="API 키" value={keyEditor.value} disabled={locked}
                    onChange={event => setKeyEditor({ provider: item.id, value: event.target.value })}/>
                  <button className="button primary" disabled={locked || keyEditor.value.length < 8 || /\s/u.test(keyEditor.value)}>키 저장</button>
                </form>}
              </li>;
            })}
          </ul>
        </section>
        <section className="connection-section" aria-label="이미지 생성">
          <div className="connection-heading"><h2>이미지 생성</h2></div>
          <div className="connection-surface connection-row inference-image-row">
            <span className="connection-icon"><Image size={17} aria-hidden="true"/></span>
            <div className="connection-row-copy"><h3>기본 제공자</h3>
              <p>{imageProviders.find(item => item.id === data.settings.image_provider)?.image_note ?? 'Codex는 CLI 로그인, MiniMax는 등록된 API 키를 사용합니다.'}</p>
            </div>
            <select aria-label="이미지 제공자" value={data.settings.image_provider} disabled={locked || !imageProviders.length} onChange={event => void save({ operation: 'image_provider', provider: event.target.value }, '이미지 제공자를 저장했습니다.')}>
              {!imageProviders.some(item => item.id === data.settings.image_provider) && <option value={data.settings.image_provider}>{data.settings.image_provider} · 사용 불가</option>}
              {imageProviders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
        </section>
      </>}
      {pair && primary && (reviewerOptions.length > 0 || savedReviewer) && <section className="inference-pair-body" aria-label="독립 리뷰">
        <div className="inference-pair-settings">
          <div className="inference-fields">
            <label>독립 리뷰<select value={reviewProvider ?? savedReviewer} disabled={locked} onChange={event => setReviewProvider(event.target.value)}>
              <option value="">자동 리뷰 끄기</option>
              {savedReviewer && !reviewerOptions.some(item => item.id === savedReviewer) && <option value={savedReviewer} disabled>{savedReviewer} · 사용 불가</option>}
              {reviewerOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
          </div>
          <p className="field-help">새 공개 업무의 요구사항과 산출물을 선택한 제공자에게 보내 독립 리뷰를 받습니다.</p>
          <div className="inference-footer">
            <button type="button" className="button secondary" disabled={locked || reviewProvider === undefined || reviewProvider === savedReviewer
              || (reviewProvider !== '' && !proposedReviewer)} onClick={() => void save({
                operation: 'set_orchestra', ...pair, profile: { routes: orchestra?.routes ?? {},
                  reviewer: proposedReviewer?.default_model ? { provider: proposedReviewer.id, model: proposedReviewer.default_model,
                    effort: proposedReviewer.default_effort } : null },
              }, proposedReviewer ? '새 공개 업무의 독립 리뷰를 켰습니다.' : '독립 리뷰 권한을 해제했습니다.')}>
              {proposedReviewer ? '전송 허용 및 켜기' : '독립 리뷰 끄기'}
            </button>
          </div>
        </div>
      </section>}
      {pair && <fieldset className="connection-fieldset inference-pair-images" disabled={locked}><ImageComposer pair={pair}/></fieldset>}
    </>}
    {notice && <p className="connection-message" role="status">{notice}</p>}
    {error && <div className="connection-message connection-message--error" role="alert"><span>{error}</span>
      <button type="button" className="button secondary" disabled={disabled || busy || !connected} onClick={refresh}>다시 확인</button>
    </div>}
  </>;

  return <section className={pair ? 'inference-settings inference-settings--pair' : 'inference-settings connections-stack'} aria-label={pair ? '이 대화의 모델' : '추론 설정'}>
    {pair ? <>
      <button className="button secondary inference-pair-trigger" type="button" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <Cpu size={14}/><span>{selected ? `${selected.model} · ${effortLabel(selected.effort)}` : '대화 모델'}</span>
      </button>
      {settingsOpen && <Modal title="대화 모델" onClose={() => {
        if (saving.current) return;
        setSettingsOpen(false);
        setAllow(false);
        setReviewProvider(undefined);
      }}><div className="form-stack">{fields}</div></Modal>}
    </> : fields}
  </section>;
}
