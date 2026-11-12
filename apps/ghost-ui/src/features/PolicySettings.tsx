import { useState, type FormEvent } from 'react';
import type { PolicyConditions, PolicyDecision, PolicyReviewer, PolicyRule } from '@ghost/contract';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice, EditorActions, errorText, TextField } from './InfrastructureFields';

const decisions: { value: PolicyDecision; label: string }[] = [{ value: 'deny', label: '거부' }, { value: 'owner', label: '소유자' }, { value: 'review', label: '평가 후 허용' }, { value: 'allow', label: '허용' }];
const targets = [{ value: '', label: '모든 대상' }, { value: 'workspace', label: '작업 자리' }, { value: 'scope_path', label: '프로젝트 경로' }, { value: 'mac', label: '범위 밖 Mac' }, { value: 'document_vault', label: '문서 금고' }, { value: 'connection', label: '연결' }, { value: 'mcp_server', label: 'MCP 서버' }, { value: 'browser_origin', label: '브라우저 출처' }, { value: 'mail_account', label: '메일 계정' }, { value: 'host', label: 'Host' }];
const booleanAxes = [{ key: 'reversible', label: '되돌림', yes: '가능', no: '불가' }, { key: 'external', label: '바깥 전송', yes: '있음', no: '없음' }, { key: 'amount', label: '금액', yes: '있음', no: '없음' }, { key: 'untrustedInput', label: '신뢰할 수 없는 입력', yes: '읽음', no: '읽지 않음' }, { key: 'privateData', label: '비공개 데이터', yes: '읽음', no: '읽지 않음' }] as const;

export function PolicySettings({ scopeId }: { scopeId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [editing, setEditing] = useState<PolicyRule | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const rules = (state?.policyRules ?? []).filter(rule => scopeId === undefined || !rule.scopeId || rule.scopeId === scopeId);
  const remove = async (ruleId: string) => {
    setBusy(true); setError('');
    try { await client.send({ type: 'rule.delete', ruleId }); setRemoving(null); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <SettingsGroup title="정책 규칙" actions={<Button onClick={() => setEditing('new')}>규칙 추가</Button>}>
    <p className="infra-record__meta">겹치는 규칙은 거부 → 소유자 → 평가 → 허용 순으로 적용됩니다.</p>
    {error && <InlineError>{error}</InlineError>}
    {editing && <RuleEditor key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? null : editing} scopeId={scopeId} onClose={() => setEditing(null)}/>}
    {!rules.length && !editing && <p className="infra-record__meta">등록된 규칙이 없습니다.</p>}
    {rules.map(rule => <article className="infra-record" key={rule.id}>
      <div className="infra-record__head"><h3>{decisions.find(item => item.value === rule.decision)?.label} · {rule.tool}</h3><div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setEditing(rule)}>편집</Button><Button size="sm" variant="ghost" onClick={() => setRemoving(rule.id)}>삭제</Button></div></div>
      <p className="infra-record__meta">{rule.scopeId ? state?.scopes.find(scope => scope.id === rule.scopeId)?.name ?? rule.scopeId : '전체'} · {rule.ghostId ? state?.ghosts.find(ghost => ghost.id === rule.ghostId)?.name ?? rule.ghostId : '모든 Ghost'} · 개정 {rule.revision}</p>
      <p className="infra-record__meta">{[targets.find(target => target.value === rule.when.targetKind)?.label, rule.when.targetId, rule.when.access === 'read' ? '읽기' : rule.when.access === 'write' ? '쓰기' : null, ...booleanAxes.filter(axis => rule.when[axis.key] !== undefined).map(axis => `${axis.label} ${rule.when[axis.key] ? axis.yes : axis.no}`)].filter(Boolean).join(' · ') || '모든 효과'}</p>
      {rule.reviewer && <p className="infra-record__meta">평가자 {rule.reviewer.kind === 'main' ? '기본 Ghost' : rule.reviewer.kind === 'slot' ? rule.reviewer.slot : state?.ghosts.find(ghost => rule.reviewer?.kind === 'ghost' && ghost.id === rule.reviewer.ghostId)?.name ?? rule.reviewer.ghostId}</p>}
      {(rule.maxPerDay || rule.maxAmount) && <p className="infra-record__meta">{[rule.maxPerDay && `하루 ${rule.maxPerDay}회`, rule.maxAmount && `${rule.maxAmount.value} ${rule.maxAmount.currency}`].filter(Boolean).join(' · ')}</p>}
      {removing === rule.id && <div className="infra-delete"><p>이 규칙을 삭제할까요? 남은 규칙에 따라 효과가 처리됩니다.</p><div className="infra-actions"><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => void remove(rule.id)}>규칙 삭제</Button></div></div>}
    </article>)}
  </SettingsGroup>;
}

function RuleEditor({ rule, scopeId: initialScope, onClose }: { rule: PolicyRule | null; scopeId?: string; onClose(): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [scopeId, setScopeId] = useState(rule === null ? initialScope ?? '' : rule.scopeId ?? '');
  const [ghostId, setGhostId] = useState(rule?.ghostId ?? '');
  const [triggerId, setTriggerId] = useState(rule?.triggerId ?? '');
  const [tool, setTool] = useState(rule?.tool ?? '*');
  const [when, setWhen] = useState<PolicyConditions>(rule?.when ?? {});
  const [decision, setDecision] = useState<PolicyDecision>(rule?.decision ?? 'owner');
  const [reviewer, setReviewer] = useState<string>(rule?.reviewer?.kind ?? 'none');
  const [reviewerGhost, setReviewerGhost] = useState(rule?.reviewer?.kind === 'ghost' ? rule.reviewer.ghostId : '');
  const [reviewerSlot, setReviewerSlot] = useState(rule?.reviewer?.kind === 'slot' ? rule.reviewer.slot : '');
  const [daily, setDaily] = useState(rule?.maxPerDay?.toString() ?? '');
  const [amount, setAmount] = useState(rule?.maxAmount?.value.toString() ?? '');
  const [currency, setCurrency] = useState(rule?.maxAmount?.currency ?? 'KRW');
  const [minutes, setMinutes] = useState(rule?.autoResolve?.afterMinutes.toString() ?? '');
  const [answer, setAnswer] = useState(rule?.autoResolve?.answer ?? 'approve');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const axis = <K extends keyof PolicyConditions>(key: K, value: PolicyConditions[K]) => setWhen(current => { const next = { ...current }; if (value === undefined || value === '') delete next[key]; else next[key] = value; return next; });
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const review: PolicyReviewer | undefined = reviewer === 'main' ? { kind: 'main' } : reviewer === 'ghost' ? { kind: 'ghost', ghostId: reviewerGhost } : reviewer === 'slot' ? { kind: 'slot', slot: reviewerSlot } : undefined;
      if (decision === 'review' && !review) throw new Error('평가자를 선택하세요.');
      const input = { scopeId: scopeId || undefined, ghostId: ghostId || undefined, triggerId: triggerId || undefined, tool: tool.trim(), when, decision, reviewer: decision === 'review' || decision === 'owner' ? review : undefined, maxPerDay: daily ? Number(daily) : undefined, maxAmount: amount ? { value: Number(amount), currency } : undefined, autoResolve: minutes && (decision === 'owner' || decision === 'review') ? { afterMinutes: Number(minutes), answer } : undefined };
      await client.send(rule ? { type: 'rule.update', ruleId: rule.id, ...input, scopeId: input.scopeId ?? null, ghostId: input.ghostId ?? null, triggerId: input.triggerId ?? null, reviewer: input.reviewer ?? null, maxPerDay: input.maxPerDay ?? null, maxAmount: input.maxAmount ?? null, autoResolve: input.autoResolve ?? null } : { type: 'rule.create', ...input }); onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" onSubmit={event => void save(event)} aria-label={rule ? '정책 규칙 편집' : '정책 규칙 추가'}>
    <fieldset disabled={busy} className="infra-form border-0 m-0 p-0">
      <div className="infra-columns">
        <Choice label="프로젝트" value={scopeId} onChange={setScopeId} options={[{ value: '', label: '전체' }, ...(state?.scopes ?? []).map(scope => ({ value: scope.id, label: scope.name }))]}/>
        <Choice label="실행 Ghost" value={ghostId} onChange={setGhostId} options={[{ value: '', label: '모든 Ghost' }, ...(state?.ghosts ?? []).filter(ghost => !ghost.deletedAt).map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>
      </div>
      <Choice label="계기" value={triggerId} onChange={setTriggerId} options={[{ value: '', label: '모든 계기' }, ...(state?.activities ?? []).filter(activity => !activity.deletedAt).map(activity => ({ value: activity.id, label: activity.name }))]}/>
      <TextField label="도구 무늬" value={tool} onChange={setTool} required placeholder="mcp.*"/>
      <div className="infra-columns">
        <Choice label="대상" value={when.targetKind ?? ''} onChange={value => axis('targetKind', value ? value as PolicyConditions['targetKind'] : undefined)} options={targets}/>
        <TextField label="대상 ID 무늬" value={when.targetId ?? ''} onChange={value => axis('targetId', value || undefined)}/>
        <Choice label="접근" value={when.access ?? ''} onChange={value => axis('access', value ? value as 'read' | 'write' : undefined)} options={[{ value: '', label: '모두' }, { value: 'read', label: '읽기' }, { value: 'write', label: '쓰기' }]}/>
        {booleanAxes.map(item => <Choice key={item.key} label={item.label} value={when[item.key] === undefined ? '' : String(when[item.key])} onChange={value => axis(item.key, value === '' ? undefined : value === 'true')} options={[{ value: '', label: '모두' }, { value: 'true', label: item.yes }, { value: 'false', label: item.no }]}/>)}
      </div>
      <Choice label="결정" value={decision} onChange={value => setDecision(value as PolicyDecision)} options={decisions}/>
      {(decision === 'review' || decision === 'owner') && <>
        <Choice label="평가자" value={reviewer} onChange={setReviewer} options={[{ value: 'none', label: '없음' }, { value: 'main', label: '기본 Ghost' }, { value: 'ghost', label: 'Ghost 지정' }, { value: 'slot', label: '모델 자리' }]}/>
        {reviewer === 'ghost' && <Choice label="평가 Ghost" required value={reviewerGhost} onChange={setReviewerGhost} options={[{ value: '', label: '선택' }, ...(state?.ghosts ?? []).filter(ghost => !ghost.deletedAt).map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>}
        {reviewer === 'slot' && <Choice label="평가 모델 자리" required value={reviewerSlot} onChange={setReviewerSlot} options={[{ value: '', label: '선택' }, ...Object.keys(state?.settings.slots ?? {}).map(name => ({ value: name, label: name }))]}/>}
        <div className="infra-columns"><TextField label="자동 처리까지 (분, 비우면 사용 안 함)" type="number" min={1} max={1440} value={minutes} onChange={setMinutes}/><Choice label="자동 처리" value={answer} onChange={value => setAnswer(value as 'approve' | 'recommended')} options={[{ value: 'approve', label: '승인' }, { value: 'recommended', label: '추천안' }]}/></div>
      </>}
      <TextField label="하루 횟수 한도 (비우면 없음)" type="number" min={1} value={daily} onChange={setDaily}/>
      <div className="infra-columns"><TextField label="금액 한도 (비우면 없음)" type="number" min={0} step="any" value={amount} onChange={setAmount}/><TextField label="통화" value={currency} onChange={setCurrency} pattern="[A-Z]{3}" maxLength={3}/></div>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}<EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
