import { useState } from 'react';
import { Check, Crown } from 'lucide-react';
import { DEFAULT_APPROVAL_POLICY, DEFAULT_OWNER_LANGUAGE, type ApprovalPolicy } from '@ghost/contract';
import { InlineError, SelectField, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../features/ghostState';
import '../features/SettingsPages.css';

/** Languages offered for what Ghosts write to the owner; Ghosts still think in whatever language suits them. */
export const ownerLanguages: readonly { value: string; label: string }[] = [
  { value: 'ko', label: '한국어' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' }, { value: 'es', label: 'Español' }, { value: 'de', label: 'Deutsch' }, { value: 'fr', label: 'Français' },
];

/** Waits the owner can pick before a reversible decision goes ahead; 0 turns it off. */
export const autoWaits: readonly { value: string; label: string }[] = [
  { value: '0', label: '자동 진행 안 함' }, { value: '1', label: '1분' }, { value: '3', label: '3분' }, { value: '5', label: '5분' },
  { value: '10', label: '10분' }, { value: '30', label: '30분' },
  { value: '60', label: '1시간' }, { value: '120', label: '2시간' }, { value: '480', label: '8시간' },
];

/** The policy with one Ghost's exception set; `auto` is the default, so it is stored as no exception. */
export function withGhostRule(policy: ApprovalPolicy, ghostId: string, automatic: boolean): ApprovalPolicy {
  const ghosts = { ...policy.ghosts };
  if (automatic) delete ghosts[ghostId]; else ghosts[ghostId] = 'owner';
  return { ...policy, ghosts };
}

/**
 * 「승인과 언어」: the language everything the owner reads is written in, how long a reversible
 * decision waits before its recommendation goes ahead, whether the main Ghost may decide those,
 * and which Ghosts always wait for the owner.
 */
export function ApprovalSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const settings = state?.settings;
  const policy: ApprovalPolicy = settings?.approvals ?? DEFAULT_APPROVAL_POLICY;
  const language = settings?.ownerLanguage ?? DEFAULT_OWNER_LANGUAGE;
  const ghosts = (state?.ghosts ?? []).filter(ghost => ghost.state !== 'retired');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const save = (patch: { ownerLanguage?: string; approvals?: ApprovalPolicy }, done: string) => {
    setPending(true); setError(''); setNotice('');
    void client.send({ type: 'settings.update', ...patch })
      .then(() => setNotice(done))
      .catch(reason => setError(reason instanceof Error ? reason.message : '설정을 저장하지 못했습니다.'))
      .finally(() => setPending(false));
  };
  const languageOptions = ownerLanguages.some(option => option.value === language) ? ownerLanguages : [...ownerLanguages, { value: language, label: language }];

  return <section className="settings-ledger">
    <SettingsGroup title="언어" className="settings-ledger__group">
      <SettingsRow label="받아 볼 언어" description="답변, 질문, 승인 요청, 결과 보고에 적용됩니다.">
        <SelectField label="받아 볼 언어" className="settings-ledger__select" value={language} disabled={pending || !settings}
          onValueChange={value => save({ ownerLanguage: value }, '언어를 저장했습니다. 다음 답부터 적용됩니다.')} options={languageOptions}/>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="자동 승인" className="settings-ledger__group" description="결제, 카드 입력, 메일·댓글 발송, 삭제는 직접 승인해야 합니다.">
      <SettingsRow label="답이 없을 때" description="추천안이 있는 질문이나 되돌릴 수 있는 요청을 추천대로 진행합니다.">
        <SelectField label="답이 없을 때" className="settings-ledger__select" value={String(policy.autoMinutes)} disabled={pending || !settings}
          onValueChange={value => save({ approvals: { ...policy, autoMinutes: Number(value) } }, '자동 진행 시간을 저장했습니다.')}
          options={autoWaits.some(option => option.value === String(policy.autoMinutes)) ? [...autoWaits] : [...autoWaits, { value: String(policy.autoMinutes), label: `${policy.autoMinutes}분` }]}/>
      </SettingsRow>
      <SettingsRow label="메인 Ghost가 먼저 검토" description="되돌릴 수 있는 요청은 대신 정하고, 직접 승인이 필요한 요청에는 의견만 남깁니다." htmlFor="delegate-switch">
        <Switch id="delegate-switch" checked={policy.delegate === 'reversible'} disabled={pending || !settings}
          onCheckedChange={checked => save({ approvals: { ...policy, delegate: checked ? 'reversible' : 'none' } }, checked ? '메인 Ghost가 먼저 검토합니다.' : '메인 검토 없이 직접 판단합니다.')}/>
      </SettingsRow>
    </SettingsGroup>

    {ghosts.length > 0 && <SettingsGroup title="Ghost별 자동 승인" className="settings-ledger__group"
      description="메인 Ghost는 자기 요청을 검토하지 않습니다. 자동 진행 시간만 적용됩니다.">
      <div className="approval-roster" role="group" aria-label="Ghost별 자동 승인">
        {ghosts.map(ghost => {
          const automatic = policy.ghosts?.[ghost.id] !== 'owner';
          return <button key={ghost.id} type="button" className="approval-roster__row" aria-pressed={automatic} disabled={pending || !settings}
            aria-label={`${ghost.name}: ${automatic ? '자동 승인' : '직접 승인'}`}
            onClick={() => save({ approvals: withGhostRule(policy, ghost.id, !automatic) }, `${ghost.name}: ${automatic ? '늘 직접 승인' : '자동 승인 켬'}`)}>
            <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={24}/>
            <span className="approval-roster__name">{ghost.name}{ghost.isDefault && <Crown aria-label="메인 Ghost"/>}</span>
            <span className="approval-roster__mode">{automatic ? '자동 승인' : '직접 승인'}</span>
          </button>;
        })}
      </div>
    </SettingsGroup>}

    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
  </section>;
}
