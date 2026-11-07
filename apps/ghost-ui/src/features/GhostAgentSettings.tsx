import { useState } from 'react';
import { Button, Checkbox, GSettingsGroup, GSettingsRow, InlineError, Textarea } from '@garden/ui';
import { GHOST_TOOLS, type GhostTool } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';

const toolLabels: Record<GhostTool, string> = {
  work_create: '일 만들기',
  work_list: '일 목록 보기',
  work_inspect: '일 자세히 보기',
  work_update: '일 내용 고치기',
  work_cancel: '일 취소',
  schedule_create: '반복 작업 만들기',
  schedule_list: '반복 작업 보기',
  schedule_cancel: '반복 작업 취소',
  ghost_list: 'Ghost 목록 보기',
  read: '파일 읽기',
  write: '파일 쓰기',
  edit: '파일 고치기',
  bash: '명령 실행',
  publish_artifact: '결과물 공유',
  delegate: '다른 Ghost에게 맡기기',
  memory_search: '기억 검색',
  memory_recall: '기억 불러오기',
  memory_retain: '기억 저장하기',
  document_spaces: '문서 공간 보기',
  document_list: '문서 목록 보기',
  document_read: '문서 읽기',
  document_propose: '문서 수정 제안',
};

/** 용도별 묶음. 목록은 contract의 GHOST_TOOLS를 따르고, 여기 없는 새 도구는 기타 도구로 내려간다. */
const toolGroups: readonly { title: string; description: string; tools: readonly GhostTool[] }[] = [
  { title: '맡긴 일', description: '작업을 만들고 상황을 보고 고칩니다.', tools: ['work_create', 'work_list', 'work_inspect', 'work_update', 'work_cancel'] },
  { title: '반복 작업', description: '정해진 시간에 실행할 작업을 관리합니다.', tools: ['schedule_create', 'schedule_list', 'schedule_cancel'] },
  { title: '파일과 명령', description: '샌드박스 안의 파일을 읽고 고치고 명령을 실행합니다.', tools: ['read', 'write', 'edit', 'bash'] },
  { title: '기억', description: '오래 기억할 것을 저장하고 다시 찾아봅니다.', tools: ['memory_search', 'memory_recall', 'memory_retain'] },
  { title: '문서 공간', description: '프로젝트 문서를 읽고 수정을 제안합니다.', tools: ['document_spaces', 'document_list', 'document_read', 'document_propose'] },
  { title: '협업', description: '다른 Ghost와 함께 일하고 결과물을 공유합니다.', tools: ['ghost_list', 'publish_artifact', 'delegate'] },
];

/** 대화 종류에 따라 항상 제공되는 도구. 선택 목록에 없다. */
const lifecycleTools: readonly { tool: string; label: string; note: string }[] = [
  { tool: 'ask_owner', label: '소유자에게 묻기', note: '스스로 판단하기 어려울 때 질문' },
  { tool: 'complete', label: '일 완료 보고', note: '맡긴 일을 끝냈을 때' },
  { tool: 'work_status', label: '일 상태 보고', note: '진행 상황을 알릴 때' },
  { tool: 'artifact_read', label: '결과물 읽기', note: '일에 붙은 결과물 확인' },
  { tool: 'effect_list', label: '실행 기록 보기', note: '검토할 일의 실행 기록 조회' },
  { tool: 'verdict', label: '검토 판정', note: '검토 대화에서 판정' },
];

/**
 * 한 Ghost의 역할 지시와 도구 권한을 고치는 설정 편집기. 모습은 GhostDesignEditor(꾸미기)가 맡는다.
 * 선택 목록은 contract의 GHOST_TOOLS이고 저장은 ghost.update로 즉시 반영된다.
 */
export function GhostAgentSettingsEditor({ ghostId }: { ghostId: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghost = state?.ghosts.find(item => item.id === ghostId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [personaDraft, setPersonaDraft] = useState<string | null>(null);
  const [toolsDraft, setToolsDraft] = useState<Partial<Record<GhostTool, boolean>>>({});
  if (!ghost) return <p className="m-0 text-caption text-ink-3">Ghost를 찾을 수 없습니다.</p>;
  const locked = busy;
  const persona = personaDraft ?? ghost.persona;
  const savedTools = ghost.tools;
  // Keep only the owner's toggles, so an update by the main Ghost does not get overwritten for untouched tools.
  const draft = GHOST_TOOLS.filter(tool => toolsDraft[tool] ?? savedTools.includes(tool));
  const toolsChanged = draft.length !== savedTools.length || savedTools.some(tool => !draft.includes(tool));
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };
  const toggle = (tool: GhostTool, on: boolean) => {
    setNotice(''); setError('');
    setToolsDraft(current => {
      const next = { ...current };
      if (on === savedTools.includes(tool)) delete next[tool];
      else next[tool] = on;
      return next;
    });
  };
  const grouped = new Set<GhostTool>(toolGroups.flatMap(group => [...group.tools]));
  const extra = GHOST_TOOLS.filter(tool => !grouped.has(tool));
  const toolRow = (tool: GhostTool) => {
    const id = `ghost-tool-${ghostId}-${tool}`;
    return <GSettingsRow key={tool} label={toolLabels[tool]} htmlFor={id}>
      <Checkbox id={id} checked={draft.includes(tool)} disabled={locked} onCheckedChange={on => toggle(tool, on === true)}/>
    </GSettingsRow>;
  };
  return <div className="grid gap-4">
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      if (persona.trim() && persona !== ghost.persona) void run(async () => {
        await client.send({ type: 'ghost.update', ghostId, persona });
        setPersonaDraft(null);
      }, '역할 지시를 저장했습니다.');
    }}>
      <label className="grid gap-2 text-caption text-ink-2">{uiTerms.roleInstructions}
        <Textarea value={persona} onChange={event => setPersonaDraft(event.target.value)} rows={4} maxLength={8192} required disabled={locked}/>
      </label>
      {persona !== ghost.persona && <Button type="submit" size="sm" className="justify-self-end" disabled={locked || !persona.trim()}>저장</Button>}
    </form>
    <section className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-caption font-medium text-ink-2">도구 권한</h4>
        {toolsChanged && <Button size="sm" type="button" disabled={locked} onClick={() => void run(async () => {
          await client.send({ type: 'ghost.update', ghostId, tools: draft });
          setToolsDraft({});
        }, '도구 권한을 저장했습니다.')}>저장</Button>}
      </div>
      {toolGroups.map(group => <GSettingsGroup key={group.title} title={group.title} description={group.description}>
        {group.tools.map(toolRow)}
      </GSettingsGroup>)}
      {extra.length > 0 && <GSettingsGroup title="기타 도구">{extra.map(toolRow)}</GSettingsGroup>}
      <GSettingsGroup title="항상 제공되는 도구" description="Ghost가 일을 안전하게 진행하도록 대화 종류에 따라 항상 쓰는 도구입니다. 선택 목록에 없고 끌 수 없습니다.">
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {lifecycleTools.map(({ tool, label, note }) => <li key={tool} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-caption">
            <span className="text-ink">{label}</span><span className="text-ink-3">{note}</span>
          </li>)}
        </ul>
      </GSettingsGroup>
      <p className="m-0 text-caption text-ink-3">메인 Ghost만 직접 대화에서 다른 Ghost의 설정을 바꿀 수 있습니다. 자기 설정과 메인 지정은 소유자만 바꿉니다.</p>
      {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
      {error && <InlineError>{error}</InlineError>}
    </section>
  </div>;
}
