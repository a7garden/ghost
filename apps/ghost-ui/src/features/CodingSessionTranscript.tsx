import { memo, useMemo, type ReactNode } from 'react';
import { Braces, CircleAlert, GitFork } from 'lucide-react';
import type { CodingImage, CodingItem, CodingSession, CodingToolStatus } from '@ghost/contract';
import { StateGlyph, type GlyphState } from '../components/agent/StateGlyph';
import { MessageBody } from '../components/MessageBody';
import { CodingSessionPreview } from './CodingSessionPreview';
import { HerdrDiffText } from './HerdrChanges';

const states: Record<CodingSession['state'], [GlyphState, string]> = {
  idle: ['queued', '대기'], working: ['running', '작업 중'], waiting: ['attention', '응답 필요'],
  failed: ['failed', '실패'], closed: ['cancelled', '닫힘'],
};

export function EmbeddedSessionState({ state, label = true }: { state: CodingSession['state']; label?: boolean }) {
  const [glyph, description] = states[state];
  return <StateGlyph size={15} state={glyph} mark="ring" label={label} accessibleLabel={description}/>;
}

const toolGlyph: Record<CodingToolStatus, GlyphState> = { running: 'running', done: 'done', error: 'failed' };
const toolLabels: Record<CodingToolStatus, string> = { running: '실행 중', done: '완료', error: '실패' };

function Step({ summary, children, status }: { summary: ReactNode; children: ReactNode; status?: CodingToolStatus }) {
  return <details className="embedded-step" data-status={status}>
    <summary>
      {summary}
      {status && <StateGlyph size={14} state={toolGlyph[status]} label accessibleLabel={toolLabels[status]}/>}
    </summary>
    <div className="embedded-step__body">{children}</div>
  </details>;
}

function Images({ id, images }: { id: string; images: CodingImage[] }) {
  if (!images.length) return null;
  return <div className="embedded-images">
    {images.map((image, index) => <CodingSessionPreview key={`${image.path}:${index}`} id={id} path={image.path} label={image.label ?? image.path.split('/').at(-1) ?? '이미지'} kind="image"/>) }
  </div>;
}

type ToolItem = Extract<CodingItem, { kind: 'tool' }>;
const ToolRow = memo(function ToolRow({ id, item }: { id: string; item: ToolItem }) {
  const diff = item.diff ?? ((item.tool === 'edit' || item.tool === 'write') && /^(?:diff --git |--- |@@ )/m.test(item.output) ? item.output : '');
  const output = diff === item.output ? '' : item.output;
  const summary = item.summary || item.tool;
  return <div data-kind="trail" className="embedded-tool">
    {diff || output ? <Step summary={<code title={summary}>{summary}</code>} status={item.status}>
      {diff && <HerdrDiffText value={diff} wrap={false}/>}
      {output && <pre className="embedded-tool-output" tabIndex={0} aria-label="도구 출력">{output}</pre>}
    </Step> : <div className="embedded-step-static"><Braces size={15} aria-hidden="true"/><code title={summary}>{summary}</code>
      <StateGlyph size={14} state={toolGlyph[item.status]} label accessibleLabel={toolLabels[item.status]}/>
    </div>}
    <Images id={id} images={item.images}/>
  </div>;
});

const TranscriptRow = memo(function TranscriptRow({ id, item, tools }: { id: string; item: CodingItem; tools?: ToolItem[] }) {
  switch (item.kind) {
    case 'user': return <article data-role="user" aria-label="내 지시" className="embedded-user" data-rail="muted" data-rail-label={item.text || '이미지'}>
      {item.text && <p>{item.text}</p>}<Images id={id} images={item.images}/>
    </article>;
    case 'assistant': return <article data-role="assistant" aria-label="에이전트 응답" className="embedded-reply"><MessageBody text={item.text} streaming={item.streaming}/></article>;
    case 'thinking': return <div data-kind="trail"><Step summary={<span>{item.streaming ? '생각 중' : '생각 과정'}</span>}>
      <p className="embedded-literal">{item.text}</p>
    </Step></div>;
    case 'tool': return <ToolRow id={id} item={item}/>;
    case 'subagent': return <div data-kind="trail" className="embedded-subagent">
      <Step summary={<span className="embedded-subagent__title" title={item.task}><GitFork size={14} aria-hidden="true"/><strong>{item.role}</strong><span>{item.task}</span></span>} status={item.status}>
        <p className="embedded-literal">{item.task}</p>
        {item.summary && <p className="embedded-literal">{item.summary}</p>}
        {tools?.map(tool => <ToolRow key={tool.id} id={id} item={tool}/>)}
      </Step>
    </div>;
    case 'notice': return <p className="embedded-notice" role={item.level === 'error' ? 'alert' : 'status'} data-level={item.level}>
      <CircleAlert size={16} aria-hidden="true"/>{item.text}
    </p>;
  }
});

export function CodingSessionTranscript({ id, items }: { id: string; items: readonly CodingItem[] }) {
  const { rows, children } = useMemo(() => {
    const agentIds = new Set(items.filter(item => item.kind === 'subagent').map(item => item.id));
    const rows: CodingItem[] = [];
    const children = new Map<string, ToolItem[]>();
    for (const item of items) {
      if (item.kind === 'tool' && item.subagent && agentIds.has(item.subagent)) {
        const group = children.get(item.subagent);
        if (group) group.push(item);
        else children.set(item.subagent, [item]);
      } else rows.push(item);
    }
    return { rows, children };
  }, [items]);
  // Conversation's spacing and scroll rail operate on these top-level transcript rows.
  return <>{rows.map(item => <TranscriptRow key={item.id} id={id} item={item} tools={children.get(item.id)}/>)}</>;
}
