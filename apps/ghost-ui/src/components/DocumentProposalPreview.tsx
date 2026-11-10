import { useState } from 'react';
import { SegmentedControl } from '../ui';
import { MessageBody } from './MessageBody';
import { StaticHtmlBlock } from './interactive/StaticHtmlBlock';
import './interactive/interactive.css';

/** A proposal is a preview, never a write: retain the exact body behind the source view. */
export function DocumentProposalPreview({ body, profile, title }: { body?: string; profile?: string; title?: string }) {
  const [view, setView] = useState<'preview' | 'source'>('preview');
  if (body === undefined) return <p className="decision__document-empty">본문 없음</p>;
  if (profile === 'pdc-html/1') return <StaticHtmlBlock title={title || '제안된 문서'} html={body}/>;
  // Older proposals did not carry a profile. Unknown formats stay readable, not reinterpreted.
  const markdown = profile === undefined || profile === 'pdc-markdown/1';
  return <>
    {title && <h4 className="decision__document-title">{title}</h4>}
    {markdown && <SegmentedControl aria-label="제안된 문서 보기" value={view} onValueChange={setView}
      options={[{ value: 'preview', label: '읽기' }, { value: 'source', label: '원문' }]}/>}
    <div className="decision__document-body" role="region" aria-label="제안된 문서 본문" tabIndex={0}>
      {markdown && view === 'preview' ? <MessageBody text={body} document/> : <pre className="decision__document-source">{body}</pre>}
    </div>
  </>;
}
