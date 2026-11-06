import { DetailDialog } from '../components/DetailDialog';
import { useState } from 'react';
import { Check, ChevronRight, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { Button, GSettingsGroup, GSettingsRow, InlineError, Input, SelectField } from '@garden/ui';
import type { Command, ModelProvider, ModelRole, Snapshot } from '../client/types';
import { Modal } from '../components/Modal';
import { ProviderEditor } from './ProviderEditor';
import { checkedProvider, respondingServers } from './modelResults';
import { InferenceSettings } from './InferenceSettings';

type Action = (command: Command) => Promise<Record<string, any>>;
export const MODEL_ROLES: { id: ModelRole; name: string; short: string }[] = [{ id: 'llm', name: '대화', short: 'LLM' }, { id: 'stt', name: '음성 인식', short: 'STT' }, { id: 'tts', name: '음성 합성', short: 'TTS' }];
// OMP 구독 제공자의 전송처 표기. 모르는 id는 host가 준 name을 쓴다.
const OMP_PROVIDER_NAMES: Record<string, string> = { zai: 'Z.AI', minimax: 'MiniMax' };
// Radix Select는 빈 값을 항목으로 가질 수 없으므로 '선택 안 함'을 치환한다.
const NO_MODEL = '__none__';
type Catalog = { providers: ModelProvider[]; updated_ms: number | null; checked_ms?: number; refresh?: string; source?: string };
type Installation = { id: string; name: string; path: string; roles: ModelRole[]; role_source: string };
const timeLabel = (value: number | null) => value ? new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '날짜 정보 없음';

export function ModelSettings({ snapshot, action, busy, mode, connected = true }: { snapshot: Snapshot; action: Action; busy: boolean; mode: 'live' | 'demo'; connected?: boolean }) {
  const settings = snapshot.model_settings;
  const [editor, setEditor] = useState<{ provider: ModelProvider; version: number }>(), [remove, setRemove] = useState<ModelProvider>();
  const [catalog, setCatalog] = useState<Catalog>(), [catalogOpen, setCatalogOpen] = useState(false), [search, setSearch] = useState('');
  const [discovery, setDiscovery] = useState<{ servers: ModelProvider[]; installed: Installation[] }>();
  const [pending, setPending] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const working = busy || Boolean(pending), available = Boolean(settings) && mode === 'live';
  const locked = working || !connected || !available;
  const run = async (label: string, command: Record<string, unknown>, done?: (result: Record<string, any>) => void) => {
    if (locked) return;
    setPending(label); setError(''); setNotice('');
    try { const result = await action({ type: 'workspace', action: command }); done?.(result); }
    catch (e) { setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.'); }
    finally { setPending(''); }
  };
  const openProvider = (provider: ModelProvider) => {
    if (locked) return;
    setError(''); setEditor({ provider: structuredClone(provider), version: settings?.version ?? 0 });
  };
  return <section className="flex min-w-0 flex-col gap-6" aria-label="모델 설정">
    {mode === 'live'
      ? <InferenceSettings disabled={working} connected={connected}/>
      : <p className="m-0 text-ui text-ink-2">모델 설정은 연결된 Ghost 호스트에서 사용할 수 있습니다.</p>}
    <DetailDialog title="음성 및 호환 서버">
      <div className="flex min-w-0 flex-col gap-5">
    {!available && <p className="m-0 text-caption text-ink-3">{mode === 'demo' ? '음성 설정은 호스트에 연결하면 사용할 수 있습니다.' : '모델 설정을 지원하는 호스트로 업데이트해 주세요.'}</p>}
    <GSettingsGroup title="음성 모델" description="STT·TTS 선택은 다음 통화를 시작할 때 적용됩니다.">{MODEL_ROLES.filter(role => role.id !== 'llm').map(role => {
      const selected = settings?.roles[role.id] ?? '';
      const options = settings?.providers.filter(p => p.enabled).flatMap(p => p.models.filter(m => m.roles.includes(role.id)).map(m => ({ key: `${p.id}/${m.id}`, name: `${p.name} / ${m.name}` }))) ?? [];
      const missing = selected && selected !== 'mock' && !options.some(o => o.key === selected);
      return <GSettingsRow label={role.name} description={role.short} key={role.id}>
        <SelectField label={`${role.name} 모델`} value={selected || NO_MODEL} disabled={locked} onValueChange={value => void run(role.id, { type: 'select_role_model', role: role.id, model: value === NO_MODEL ? null : value, version: settings?.version }, () => setNotice(`${role.name} 모델을 저장했습니다.`))} options={[
          { value: NO_MODEL, label: '선택 안 함' },
          ...(missing ? [{ value: selected, label: `${selected} · 사용 불가` }] : []),
          ...options.map(o => ({ value: o.key, label: o.name })),
        ]}/>
      </GSettingsRow>;
    })}</GSettingsGroup>
    <div className="flex flex-wrap items-center justify-between gap-4"><h3 className="m-0 text-ui font-semibold text-ink">제공자</h3><Button variant="outline" type="button" disabled={locked} onClick={() => openProvider({ id: `server-${crypto.randomUUID().slice(0, 8)}`, name: '', kind: 'openai_compatible', endpoint: '', auth: { type: 'none' }, roles: ['llm'], models: [], enabled: true, checked_ms: null, error: null })}><Plus size={15}/>서버 추가</Button></div>
    <div className="flex flex-wrap gap-5 border-b border-line pb-4"><Button variant="ghost" type="button" disabled={locked} onClick={() => void run('catalog', { type: 'model_catalog' }, result => { setCatalog(result as Catalog); setSearch(''); setCatalogOpen(true); })}><RefreshCw size={14}/>{pending === 'catalog' ? '목록 불러오는 중…' : '제공자 목록'}</Button><Button variant="ghost" type="button" disabled={locked} onClick={() => void run('discovery', { type: 'discover_local_models' }, result => setDiscovery({ servers: respondingServers(Array.isArray(result.servers) ? result.servers : []), installed: Array.isArray(result.installed_models) ? result.installed_models : [] }))}><Server size={14}/>{pending === 'discovery' ? '확인 중…' : '로컬 모델 찾기'}</Button></div>
    {(settings?.providers ?? []).map(provider => { const hostManaged = provider.kind === 'omp_subscription'; return <article className="flex min-w-0 flex-col gap-2 border-b border-line py-4 last:border-b-0" key={provider.id}>
      <div className="flex flex-wrap items-center justify-between gap-3.5"><div className="min-w-0"><span className="flex flex-wrap items-center gap-2.5"><span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{provider.name}</span><span className="text-caption text-ink-3">{provider.roles.map(role => role.toUpperCase()).join(' · ')}{!provider.enabled && ' · 비활성'}</span></span></div><span className="text-caption text-ink-3">{provider.models.length}개 모델</span></div>
      <p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{hostManaged ? 'OMP stdio · 로컬 구독 인증' : provider.endpoint}</p>
      {provider.error ? <InlineError>{provider.error}</InlineError> : <p className="m-0 text-caption text-ink-3">{hostManaged ? `대화 내용은 ${OMP_PROVIDER_NAMES[provider.id] ?? (provider.name || '구독 제공자')}에 전달됩니다 · OMP 로컬 구독 인증 사용 · 실제 응답은 아직 확인하지 않았습니다.` : provider.checked_ms ? `목록 확인 · ${timeLabel(provider.checked_ms)}` : '연결 확인 전'}</p>}
      {!hostManaged && <div className="flex flex-wrap items-center gap-4"><Button variant="ghost" type="button" disabled={locked} onClick={() => void run(provider.id, { type: 'check_model_provider', id: provider.id }, result => { checkedProvider(result, provider.id); setNotice(`${provider.name}의 모델 목록을 확인했습니다. 실제 응답 생성은 새 대화에서 확인하세요.`); })}><RefreshCw size={14}/>{pending === provider.id ? '확인 중…' : '목록 확인'}</Button><Button variant="ghost" type="button" disabled={locked} onClick={() => openProvider(provider)}>편집<ChevronRight size={14}/></Button><Button variant="ghost" size="icon" type="button" className="ml-auto" aria-label={`${provider.name} 제공자 삭제`} disabled={locked} onClick={() => { setError(''); setRemove(provider); }}><Trash2 size={15}/></Button></div>}
    </article>; })}
    {available && !settings?.providers.length && <p className="m-0 text-ui text-ink-3">등록된 제공자 없음</p>}
    {discovery && <section className="mt-2 flex min-w-0 flex-col" aria-label="로컬 모델 검색 결과"><h3 className="m-0 text-ui font-semibold text-ink">로컬 검색 결과</h3>
      <h4 className="mb-1.5 mt-5 text-caption font-medium text-ink-2">실행 중인 서버</h4>{discovery.servers.length ? discovery.servers.map(p => <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line py-3.5" key={p.id}><div className="min-w-0"><strong className="text-caption font-semibold text-ink [overflow-wrap:anywhere]">{p.name}</strong><p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{p.endpoint}</p><span className="text-caption text-ink-3">{p.models.length}개 모델 · 목록 응답 확인</span></div><Button variant="outline" type="button" className="flex-none" disabled={locked} onClick={() => openProvider(p)}>{settings?.providers.some(v => v.id === p.id) ? '설정 검토' : '등록'}</Button></div>) : <p className="m-0 text-caption text-ink-3">실행 중인 로컬 서버를 찾지 못했습니다.</p>}
      {discovery.installed.length > 0 && <><h4 className="mb-1.5 mt-5 text-caption font-medium text-ink-2">설치 흔적</h4>{discovery.installed.map((m, i) => <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line py-3.5" key={`${m.path}:${i}`}><div className="min-w-0"><strong className="text-caption font-semibold text-ink [overflow-wrap:anywhere]">{m.name}</strong><p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{m.path}</p><span className="text-caption text-ink-3">{m.roles.length ? `${m.roles.map(r => r.toUpperCase()).join(' · ')} · 이름에서 추정 · ` : ''}서버 시작 필요</span></div></div>)}<p className="m-0 mt-3 text-caption text-ink-3">디스크의 이름과 경로만 확인한 결과입니다. 모델 파일의 완전성과 실행 여부는 확인하지 않았습니다.</p></>}
    </section>}
    {error && <InlineError>{error}</InlineError>}{notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
    {catalogOpen && catalog && <Modal title="제공자 목록" onClose={() => setCatalogOpen(false)}><div className="flex flex-col gap-4"><Input aria-label="제공자 검색" placeholder="제공자 검색" value={search} onChange={e => setSearch(e.target.value)}/><p className="m-0 text-caption text-ink-3">{catalog.refresh === 'updated' ? '갱신된 목록' : catalog.refresh === 'failed_using_fallback' || catalog.refresh === 'offline' ? '갱신 실패 · 저장된 목록 사용' : '저장된 목록'} · {timeLabel(catalog.updated_ms)}<br/>목록에 있는 모델의 계정 접근 권한과 실제 응답 생성은 별도 확인이 필요합니다.</p><div className="max-h-[48dvh] overflow-auto">{catalog.providers.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(search.toLowerCase())).map(p => <Button key={p.id} variant="ghost" type="button" className="h-auto w-full justify-between gap-3 rounded-none border-b border-line px-2 py-2.5 text-left font-normal hover:bg-hover" disabled={locked} onClick={() => { setCatalogOpen(false); openProvider(settings?.providers.find(v => v.id === p.id) ?? p); }}><span className="flex min-w-0 flex-col items-start gap-1 text-left"><span className="font-semibold [overflow-wrap:anywhere]">{p.name}</span><span className="text-caption font-normal text-ink-3">{p.models.length}개 모델</span></span><ChevronRight size={16} className="flex-none"/></Button>)}</div></div></Modal>}
    {editor && <ProviderEditor initial={editor.provider} version={editor.version} existing={Boolean(settings?.providers.some(p => p.id === editor.provider.id))} busy={working} saveBlocked={!connected ? '호스트에 연결하면 저장할 수 있습니다.' : !available ? '호스트에서 모델 설정을 읽을 수 없습니다.' : undefined} onClose={() => setEditor(undefined)} onSave={async (provider, version) => { if (locked) throw new Error('호스트에 연결한 뒤 다시 시도해 주세요.'); await action({ type: 'workspace', action: { type: 'save_model_provider', provider, version } }); setEditor(undefined); setNotice(`${provider.name}을 저장했습니다.`); }}/>}
    {remove && <Modal title="제공자 삭제" onClose={() => !working && setRemove(undefined)}><p className="m-0">{remove.name}의 서버 설정을 삭제합니다.</p>{error && <InlineError>{error}</InlineError>}<div className="mt-4 flex justify-end gap-2"><Button variant="outline" type="button" disabled={working} onClick={() => setRemove(undefined)}>취소</Button><Button variant="destructive" type="button" disabled={locked} onClick={() => void run('delete', { type: 'delete_model_provider', id: remove.id, version: settings?.version }, () => { setRemove(undefined); setNotice('제공자 설정을 삭제했습니다.'); })}>삭제</Button></div></Modal>}
      </div>
    </DetailDialog>
  </section>;
}
