import { useState, type FormEvent } from 'react';
import type { PolicyConditions, PolicyDecision, PolicyReviewer, PolicyRule } from '@ghost/contract';
import { Badge, Button, InlineError, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { Choice, EditorActions, errorText, TextField } from './InfrastructureFields';
import { conditionAxes, decisionHints, decisionLabels, describeRule, isSystemRule, targetKinds, toolLabel } from './policyText';

const outcomeTone: Record<PolicyDecision, 'success' | 'warning' | 'default' | 'danger'> = { allow: 'success', owner: 'warning', review: 'default', deny: 'danger' };
const decisions = (['deny', 'owner', 'review', 'allow'] as const).map(value => ({ value, label: decisionLabels[value] }));
/** The actions people actually write rules about; anything else is typed in under 「직접 입력」. */
const toolChoices = ['*', 'browser_*', 'desktop_*', 'host_command_propose', 'mail_send', 'document_propose', 'connection_request', 'mcp.*'];
const CUSTOM = '__custom';

export function PolicySettings({ scopeId }: { scopeId?: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [editing, setEditing] = useState<PolicyRule | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const rules = (state?.policyRules ?? []).filter(rule => scopeId === undefined || !rule.scopeId || rule.scopeId === scopeId);
  const own = rules.filter(rule => !isSystemRule(rule)), builtIn = rules.filter(isSystemRule);
  const remove = async (ruleId: string) => {
    setBusy(true); setError('');
    try { await client.send({ type: 'rule.delete', ruleId }); setRemoving(null); }
    catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const row = (rule: PolicyRule) => {
    const text = describeRule(rule, state);
    const fromActivity = rule.id.startsWith('activity:');
    return <article className="infra-entry" key={rule.id}>
      <SettingsRow label={<span className="flex flex-wrap items-center gap-2">{text.subject}<Badge variant={outcomeTone[rule.decision]}>{text.outcome}</Badge></span>}
        description={[text.conditions.join(' · '), text.reach, ...text.extras, fromActivity ? '자동 활동 설정에서 바꿉니다.' : ''].filter(Boolean).join(' · ')}>
        {!fromActivity && <span className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setEditing(rule); setError(''); }}>편집</Button>
          {!isSystemRule(rule) && <Button size="sm" variant="ghost" onClick={() => setRemoving(rule.id)}>삭제</Button>}
        </span>}
      </SettingsRow>
      {removing === rule.id && <div className="infra-delete px-4 pb-4"><p>이 규칙을 삭제할까요? 남은 규칙에 따라 처리됩니다.</p><div className="infra-actions"><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => void remove(rule.id)}>규칙 삭제</Button></div></div>}
    </article>;
  };
  return <section className="grid gap-6" aria-label={uiTerms.rules}>
    <SettingsGroup title={uiTerms.rules} actions={<Button onClick={() => { setEditing('new'); setError(''); }}>규칙 추가</Button>}
      description="Ghost가 돈을 쓰거나 보내거나 지우려 할 때 누가 정할지 정합니다. 겹치면 가장 엄격한 규칙이 이깁니다.">
      {error && <InlineError className="m-4">{error}</InlineError>}
      {editing && <RuleEditor key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? null : editing} scopeId={scopeId} onClose={() => setEditing(null)}/>}
      {!own.length && !editing && <p className="m-0 p-4 text-caption text-ink-2">직접 만든 규칙이 없습니다. 기본 안전 규칙만 적용됩니다. 자동 승인 시간은 「승인과 언어」에서 바꿉니다.</p>}
      {own.map(row)}
    </SettingsGroup>
    {builtIn.length > 0 && <details className="infra-fold">
      <summary>기본 안전 규칙 {builtIn.length}개</summary>
      <p className="m-0 mb-3 text-caption text-ink-2">처음부터 적용되는 규칙입니다. 더 엄격하게 하려면 위에서 규칙을 추가하세요.</p>
      <div className="ghost-settings-group__rows">{builtIn.map(row)}</div>
    </details>}
  </section>;
}

function RuleEditor({ rule, scopeId: initialScope, onClose }: { rule: PolicyRule | null; scopeId?: string; onClose(): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [scopeId, setScopeId] = useState(rule === null ? initialScope ?? '' : rule.scopeId ?? '');
  const [ghostId, setGhostId] = useState(rule?.ghostId ?? '');
  const [triggerId, setTriggerId] = useState(rule?.triggerId ?? '');
  const choices = rule && !toolChoices.includes(rule.tool) && toolLabel(rule.tool) !== rule.tool ? [...toolChoices, rule.tool] : toolChoices;
  const knownTool = rule === null ? '*' : choices.includes(rule.tool) ? rule.tool : CUSTOM;
  const [toolChoice, setToolChoice] = useState(knownTool);
  const [customTool, setCustomTool] = useState(knownTool === CUSTOM ? rule?.tool ?? '' : '');
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
  const tool = (toolChoice === CUSTOM ? customTool : toolChoice).trim();
  const settled = decision === 'review' || decision === 'owner';
  const review: PolicyReviewer | undefined = reviewer === 'main' ? { kind: 'main' } : reviewer === 'ghost' && reviewerGhost ? { kind: 'ghost', ghostId: reviewerGhost } : reviewer === 'slot' && reviewerSlot ? { kind: 'slot', slot: reviewerSlot } : undefined;
  const input = { scopeId: scopeId || undefined, ghostId: ghostId || undefined, triggerId: triggerId || undefined, tool, when, decision, reviewer: settled ? review : undefined,
    maxPerDay: daily ? Number(daily) : undefined, maxAmount: amount ? { value: Number(amount), currency } : undefined, autoResolve: minutes && settled ? { afterMinutes: Number(minutes), answer } : undefined };
  const preview = tool ? describeRule({ id: 'draft', revision: 1, createdBy: { kind: 'owner' }, ...input } as PolicyRule, state) : null;
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (!tool) throw new Error('어떤 행동에 대한 규칙인지 정해 주세요.');
      if (decision === 'review' && !review) throw new Error('검토할 Ghost를 선택하세요.');
      await client.send(rule ? { type: 'rule.update', ruleId: rule.id, ...input, scopeId: input.scopeId ?? null, ghostId: input.ghostId ?? null, triggerId: input.triggerId ?? null, reviewer: input.reviewer ?? null, maxPerDay: input.maxPerDay ?? null, maxAmount: input.maxAmount ?? null, autoResolve: input.autoResolve ?? null } : { type: 'rule.create', ...input }); onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  const ghosts = (state?.ghosts ?? []).filter(ghost => !ghost.deletedAt);
  const narrowed = Boolean(when.targetId) || conditionAxes.some(item => when[item.key] !== undefined);
  return <form className="infra-editor" onSubmit={event => void save(event)} aria-label={rule ? `${uiTerms.rules} 편집` : `${uiTerms.rules} 추가`}>
    <fieldset disabled={busy} className="infra-form border-0 m-0 p-0">
      <Choice label="행동" value={toolChoice} onChange={setToolChoice} options={[...choices.map(value => ({ value, label: toolLabel(value) })), { value: CUSTOM, label: '직접 입력 (고급)' }]}/>
      {toolChoice === CUSTOM && <TextField label="도구 이름" required value={customTool} onChange={setCustomTool} placeholder="mcp.서버이름.*" description="* 로 여러 도구를 한 번에 가리킬 수 있습니다."/>}
      <div className="infra-columns">
        <Choice label="대상" value={when.targetKind ?? ''} onChange={value => axis('targetKind', value ? value as PolicyConditions['targetKind'] : undefined)} options={[{ value: '', label: '어디든' }, ...targetKinds]}/>
        <Choice label="종류" value={when.access ?? ''} onChange={value => axis('access', value ? value as 'read' | 'write' : undefined)} options={[{ value: '', label: '보기와 바꾸기 모두' }, { value: 'read', label: '보기만' }, { value: 'write', label: '바꾸기' }]}/>
      </div>
      <details className="infra-fold" open={narrowed}>
        <summary>더 좁히기</summary>
        <div className="infra-form">
          <TextField label="대상 이름" value={when.targetId ?? ''} onChange={value => axis('targetId', value || undefined)} placeholder="폴더 경로, 사이트 주소 등" description="비우면 대상 전체입니다. * 로 일부만 가리킬 수 있습니다."/>
          <div className="infra-columns">
            {conditionAxes.map(item => <Choice key={item.key} label={item.question} value={when[item.key] === undefined ? '' : String(when[item.key])} onChange={value => axis(item.key, value === '' ? undefined : value === 'true')} options={[{ value: '', label: '상관없음' }, { value: 'true', label: '예' }, { value: 'false', label: '아니요' }]}/>)}
          </div>
        </div>
      </details>
      <div className="infra-columns">
        <Choice label="프로젝트" value={scopeId} onChange={setScopeId} options={[{ value: '', label: '모든 프로젝트' }, ...(state?.scopes ?? []).map(scope => ({ value: scope.id, label: scope.name }))]}/>
        <Choice label="실행하는 Ghost" value={ghostId} onChange={setGhostId} options={[{ value: '', label: '모든 Ghost' }, ...ghosts.map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>
      </div>
      {(state?.activities ?? []).some(activity => !activity.deletedAt) && <Choice label="자동 활동" value={triggerId} onChange={setTriggerId} options={[{ value: '', label: '모든 자동 활동' }, ...(state?.activities ?? []).filter(activity => !activity.deletedAt).map(activity => ({ value: activity.id, label: activity.name }))]}/>}
      <Choice label="처리" value={decision} onChange={value => setDecision(value as PolicyDecision)} options={decisions} description={decisionHints[decision]}/>
      {settled && <>
        <Choice label={decision === 'review' ? '검토자' : '먼저 의견을 낼 검토자'} value={reviewer} onChange={setReviewer}
          options={[{ value: 'none', label: '없음' }, { value: 'main', label: '메인 Ghost' }, { value: 'ghost', label: 'Ghost 지정' }, ...(Object.keys(state?.settings.slots ?? {}).length ? [{ value: 'slot', label: uiTerms.modelCombos }] : [])]}/>
        {reviewer === 'ghost' && <Choice label="검토할 Ghost" required value={reviewerGhost} onChange={setReviewerGhost} options={[{ value: '', label: '선택' }, ...ghosts.map(ghost => ({ value: ghost.id, label: ghost.name }))]}/>}
        {reviewer === 'slot' && <Choice label="검토에 쓸 모델 조합" required value={reviewerSlot} onChange={setReviewerSlot} options={[{ value: '', label: '선택' }, ...Object.keys(state?.settings.slots ?? {}).map(name => ({ value: name, label: name }))]}/>}
        <div className="infra-columns">
          <TextField label="답이 없으면 몇 분 뒤 자동 처리" type="number" min={1} max={1440} value={minutes} onChange={setMinutes} description="비우면 자동 처리하지 않습니다."/>
          <Choice label="자동 처리 방식" value={answer} onChange={value => setAnswer(value as 'approve' | 'recommended')} options={[{ value: 'approve', label: '승인' }, { value: 'recommended', label: '추천대로 진행' }]}/>
        </div>
      </>}
      <div className="infra-columns">
        <TextField label="하루 최대 횟수" type="number" min={1} value={daily} onChange={setDaily} description="넘으면 내가 확인합니다. 비우면 제한이 없습니다."/>
        <TextField label="넘으면 내가 확인할 금액" type="number" min={0} step="any" value={amount} onChange={setAmount} description="비우면 제한이 없습니다."/>
      </div>
      {amount && <TextField label="통화" value={currency} onChange={setCurrency} pattern="[A-Z]{3}" maxLength={3}/>}
    </fieldset>
    {preview && <p className="infra-preview" role="status">{[preview.subject, ...preview.conditions].join(' · ')} → <strong>{preview.outcome}</strong></p>}
    {error && <InlineError>{error}</InlineError>}<EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
