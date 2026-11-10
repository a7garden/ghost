import { useState } from 'react';
import { Check } from 'lucide-react';
import { DEFAULT_APPROVAL_POLICY, DEFAULT_OWNER_LANGUAGE, type ApprovalPolicy } from '@ghost/contract';
import { InlineError, SelectField, SettingsGroup, SettingsRow, Switch } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';

/** Languages offered for what Ghosts write to the owner; Ghosts still think in whatever language suits them. */
export const ownerLanguages: readonly { value: string; label: string }[] = [
  { value: 'ko', label: '한국어' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' }, { value: 'es', label: 'Español' }, { value: 'de', label: 'Deutsch' }, { value: 'fr', label: 'Français' },
];

/** Waits the owner can pick before a reversible decision goes ahead; 0 turns it off. */
export const autoWaits: readonly { value: string; label: string }[] = [
  { value: '0', label: '자동 진행 안 함' }, { value: '10', label: '10분' }, { value: '30', label: '30분' },
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

  return <section className="grid gap-6">
    <SettingsGroup title="언어">
      <SettingsRow label="받아 볼 언어" description="Ghost가 보내는 답 · 질문 · 승인 요청 · 결과 보고를 이 언어로 씁니다. Ghost끼리 주고받는 말과 생각은 다른 언어일 수 있습니다.">
        <SelectField label="받아 볼 언어" className="w-[200px] max-w-full" value={language} disabled={pending || !settings}
          onValueChange={value => save({ ownerLanguage: value }, '언어를 저장했습니다. 다음 답부터 적용됩니다.')} options={[...languageOptions]}/>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="자동 승인" description="되돌릴 수 있는 요청만 해당합니다. 돈을 쓰거나 · 카드를 입력하거나 · 메일과 댓글을 보내거나 · 지우는 요청은 늘 직접 승인합니다.">
      <SettingsRow label="답이 없을 때" description="추천안이 있는 질문과 되돌릴 수 있는 승인은 이 시간이 지나면 추천대로 진행합니다. 카드에 남은 시간이 보입니다.">
        <SelectField label="답이 없을 때" className="w-[200px] max-w-full" value={String(policy.autoMinutes)} disabled={pending || !settings}
          onValueChange={value => save({ approvals: { ...policy, autoMinutes: Number(value) } }, '자동 진행 시간을 저장했습니다.')}
          options={autoWaits.some(option => option.value === String(policy.autoMinutes)) ? [...autoWaits] : [...autoWaits, { value: String(policy.autoMinutes), label: `${policy.autoMinutes}분` }]}/>
      </SettingsRow>
      <SettingsRow label="메인 Ghost가 대신 판단" description="다른 Ghost의 되돌릴 수 있는 요청을 메인이 먼저 보고 승인하거나 의견을 남깁니다. 메인이 대신 정하면 알림으로 까닭을 알려 줍니다." htmlFor="delegate-switch">
        <Switch id="delegate-switch" checked={policy.delegate === 'reversible'} disabled={pending || !settings}
          onCheckedChange={checked => save({ approvals: { ...policy, delegate: checked ? 'reversible' : 'none' } }, checked ? '메인 Ghost가 대신 판단합니다.' : '모든 요청을 직접 판단합니다.')}/>
      </SettingsRow>
    </SettingsGroup>

    {ghosts.length > 0 && <SettingsGroup title="Ghost별 자동 승인" description="끄면 그 Ghost의 요청은 추천안만 보여 주고 늘 직접 승인할 때까지 기다립니다.">
      {ghosts.map(ghost => <SettingsRow key={ghost.id} label={ghost.name} htmlFor={`auto-${ghost.id}`}
        description={ghost.isDefault ? '메인 Ghost의 요청은 메인이 스스로 승인하지 않습니다. 자동 진행 시간만 적용됩니다.' : undefined}>
        <Switch id={`auto-${ghost.id}`} checked={policy.ghosts?.[ghost.id] !== 'owner'} disabled={pending || !settings}
          onCheckedChange={checked => save({ approvals: withGhostRule(policy, ghost.id, checked) }, `${ghost.name}: ${checked ? '자동 승인 켬' : '늘 직접 승인'}`)}/>
      </SettingsRow>)}
    </SettingsGroup>}

    {error && <InlineError>{error}</InlineError>}
    {notice && <p className="m-0 flex items-start gap-1.5 text-caption text-success" role="status"><Check size={14} className="mt-0.5 flex-none"/>{notice}</p>}
  </section>;
}
