import { useState } from 'react';
import { GHOST_TOOLS, type GhostTool } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { errorText, StringList } from './InfrastructureFields';

export function PatternGrants({ tools, onSave }: { tools: readonly GhostTool[]; onSave(tools: GhostTool[]): Promise<boolean> }) {
  const known = new Set<string>(GHOST_TOOLS);
  const [patterns, setPatterns] = useState<string[]>(tools.filter(tool => !known.has(tool)));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      const values = patterns.map(value => value.trim()).filter(Boolean);
      if (values.some(value => !/^[a-zA-Z0-9_.*-]+$/.test(value))) throw new Error('도구 이름과 * 무늬만 입력하세요.');
      const saved = await onSave([...new Set([...tools.filter(tool => known.has(tool)), ...values])]);
      if (!saved) setError('도구 무늬를 저장하지 못했습니다.');
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <div className="infra-form"><fieldset disabled={busy} className="border-0 p-0 m-0"><StringList label="추가 도구 무늬" values={patterns} onChange={setPatterns} max={256} placeholder="mcp.server.* 또는 conn.connection"/></fieldset>
    {error && <InlineError>{error}</InlineError>}<div className="infra-actions"><Button disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '도구 무늬 저장'}</Button></div>
  </div>;
}
