import { useState } from 'react';
import { GHOST_TOOLS, type GhostTool } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { errorText, StringList } from './InfrastructureFields';

/** Developer-only direct grants: tool names or `*` bundles the tool list above cannot express. */
export function PatternGrants({ tools, onSave }: { tools: readonly GhostTool[]; onSave(tools: GhostTool[]): Promise<boolean> }) {
  const known = new Set<string>(GHOST_TOOLS);
  const [patterns, setPatterns] = useState<string[]>(tools.filter(tool => !known.has(tool)));
  const [open, setOpen] = useState(patterns.some(value => value.trim()));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      const values = patterns.map(value => value.trim()).filter(Boolean);
      if (values.some(value => !/^[a-zA-Z0-9_.*-]+$/.test(value))) throw new Error('도구 이름은 알파벳·숫자와 . * - _ 만 쓸 수 있습니다.');
      const saved = await onSave([...new Set([...tools.filter(tool => known.has(tool)), ...values])]);
      if (!saved) setError('추가 도구를 저장하지 못했습니다.');
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <details className="min-w-0" open={open} onToggle={event => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary className="cursor-pointer text-ui font-medium">추가 도구 직접 허용 (고급)</summary>
    <p className="m-0 mt-2 text-caption text-ink-2">도구 이름이나 `mcp.서버이름.*`처럼 *를 쓴 묶음을 이 Ghost에게 직접 허용합니다. 보통은 위 도구 목록만으로 충분합니다.</p>
    <div className="infra-form mt-3">
      <fieldset disabled={busy} className="border-0 p-0 m-0 min-w-0"><StringList label="추가 도구 이름" values={patterns} onChange={setPatterns} max={256} placeholder="예: mcp.server.*"/></fieldset>
      {error && <InlineError>{error}</InlineError>}<div className="infra-actions"><Button disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '추가 도구 저장'}</Button></div>
    </div>
  </details>;
}
