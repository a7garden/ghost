import { useMemo } from 'react';
import { diffLines } from './codingChangesDisplay';

export function DiffText({ value }: { value: string }) {
  const lines = useMemo(() => diffLines(value), [value]);
  return <pre className="coding-diff" tabIndex={0} aria-label="파일 차이">
    {lines.map(({ text, kind }, i) => <span key={i} data-kind={kind}>{text}{i < lines.length - 1 ? '\n' : ''}</span>)}
  </pre>;
}
