import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Button, InlineError, SegmentedControl, SkeletonText } from '../ui';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import '../editor/styles.css';
import type { PageView } from '@ghost/contract';
import { useHost } from '../host/context';
import { isConflict, isEditableProfile } from './scopePages';
import type { EditableProfile } from './scopePages';

const MAX_BODY_BYTES = 1_048_576;
const EMPTY_DRAFT = { title: '', body: '', profile: 'pdc-markdown/1' as EditableProfile };

/** The document itself: legacy profiles read-only, edits guarded by the content hash. */
export default function PageEditor({ scopeId, pageId, onClose, onSaved, onDirtyChange }: {
  scopeId: string;
  /** null creates a new page. */
  pageId: string | null;
  onClose(): void;
  /** Refreshes the document list after a save. */
  onSaved(): void;
  /** Whether the open document holds edits that are not saved yet; a brand-new empty document holds none. */
  onDirtyChange?(dirty: boolean): void;
}) {
  const { client } = useHost();
  const [view, setView] = useState<PageView | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [hash, setHash] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(pageId !== null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [htmlView, setHtmlView] = useState<'preview' | 'source'>('preview');
  const pane = useRef<HTMLElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    (pageId === null ? titleField.current : pane.current)?.focus();
  }, [pageId]);
  const load = (targetId: string) => {
    setLoading(true); setLoadError('');
    client.page(scopeId, targetId).then(page => {
      setView(page);
      setDraft({ title: page.title, body: page.body, profile: isEditableProfile(page.profile) ? page.profile : 'pdc-markdown/1' });
      setHash(page.hash);
      setConflict(false);
      setError('');
    }).catch(reason => setLoadError(reason instanceof Error ? `문서를 불러오지 못했습니다. ${reason.message}` : '문서를 불러오지 못했습니다.')).finally(() => setLoading(false));
  };
  useEffect(() => { if (pageId !== null) load(pageId); }, [pageId, scopeId]);
  const editable = view === null ? true : isEditableProfile(view.profile);
  const dirty = !view || draft.title !== view.title || draft.body !== view.body || (isEditableProfile(view.profile) && draft.profile !== view.profile);
  const unsaved = editable && (view ? dirty : Boolean(draft.title.trim() || draft.body.trim() || draft.profile !== EMPTY_DRAFT.profile));
  useEffect(() => { onDirtyChange?.(unsaved); }, [unsaved]);
  const save = async () => {
    if (loading || loadError || !editable || saving || !dirty) return;
    const title = draft.title.trim();
    if (!title) { setError('문서 제목을 입력해 주세요.'); titleField.current?.focus(); return; }
    if (new TextEncoder().encode(draft.body).length > MAX_BODY_BYTES) { setError('저장할 내용이 너무 큽니다.'); return; }
    setSaving(true); setError('');
    try {
      const result = await client.send<{ pageId: string; hash: string }>({
        type: 'document.save',
        scopeId,
        pageId: view?.pageId ?? null,
        expectedHash: view ? hash : null,
        title,
        body: draft.body,
        ...(view ? {} : { profile: draft.profile }),
      });
      setHash(result.hash);
      setDraft(current => ({ ...current, title }));
      if (!view) { setView({ pageId: result.pageId, locator: '', title, profile: draft.profile, body: draft.body, hash: result.hash }); }
      else setView(current => current ? { ...current, title, body: draft.body, hash: result.hash } : current);
      setConflict(false);
      onSaved();
    } catch (reason) {
      if (isConflict(reason)) {
        setConflict(true);
        setError('문서가 다른 곳에서 바뀌었습니다. 저장하지 못했습니다.');
      } else {
        setError(reason instanceof Error ? `문서를 저장하지 못했습니다. ${reason.message}` : '문서를 저장하지 못했습니다.');
      }
    } finally { setSaving(false); }
  };
  const targetId = view?.pageId ?? pageId;
  const title = view ? draft.title || '제목 없음' : pageId === null ? '새 문서' : '문서';
  const ready = !loading && !loadError;
  return <section className="doc-pane" ref={pane} tabIndex={-1} aria-label={title} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); }
    if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  }}>
    <header className="doc-pane__bar">
      <Button variant="ghost" size="sm" type="button" disabled={saving} onClick={onClose}>
        <ChevronLeft size={15} aria-hidden="true"/>{unsaved ? (view ? '수정 취소' : '취소') : '문서 목록'}
      </Button>
      <div className="doc-pane__tools">
        {ready && !view && <select className="doc-pane__format" aria-label="형식" value={draft.profile} disabled={saving}
          onChange={event => {
            const profile = event.target.value as EditableProfile;
            setDraft(current => ({ ...current, profile }));
            if (profile === 'pdc-html/1') setHtmlView('source');
          }}>
          <option value="pdc-markdown/1">마크다운</option>
          <option value="pdc-html/1">HTML</option>
        </select>}
        {ready && editable && <Button size="sm" type="button" disabled={saving || !dirty || !draft.title.trim()} onClick={() => void save()}>
          {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
        </Button>}
      </div>
    </header>
    {loading && <SkeletonText label="문서를 불러오는 중…" lines={6}/>}
    {loadError && <InlineError>{loadError}</InlineError>}
    {error && <InlineError>{error}</InlineError>}
    {targetId !== null && (loadError || conflict) && <div>
      <Button variant="outline" size="sm" type="button" disabled={saving || loading} onClick={() => load(targetId)}>
        {conflict ? '수정 내용 버리고 다시 불러오기' : '다시 불러오기'}
      </Button>
    </div>}
    {ready && <article className="doc-page">
      {editable
        ? <input ref={titleField} className="doc-page__title" aria-label="제목" placeholder="문서 제목" value={draft.title}
          required maxLength={512} readOnly={saving} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}/>
        : <>
          <h2 className="doc-page__title">{title}</h2>
          <p className="doc-page__legacy">이전 형식({view?.profile}) · 읽기 전용</p>
        </>}
      {draft.profile === 'pdc-html/1'
        ? <>
          <div className="doc-page__mode">
            <SegmentedControl aria-label="HTML 표시 방식" value={htmlView} onValueChange={value => setHtmlView(value as 'preview' | 'source')}
              options={[{ value: 'preview', label: '미리보기' }, { value: 'source', label: '원문' }]}/>
          </div>
          {htmlView === 'preview'
            ? <iframe title="HTML 미리보기" sandbox="" referrerPolicy="no-referrer" className="doc-page__body"
              srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${draft.body}`}/>
            : <textarea aria-label="본문" value={draft.body} readOnly={saving} className="doc-page__body doc-page__source" spellCheck={false}
              onChange={event => setDraft(current => ({ ...current, body: event.target.value }))}/>}
        </>
        : <MarkdownEditor value={draft.body} onChange={body => setDraft(current => ({ ...current, body }))}
          label="본문" readOnly={!editable || saving} documentId={pageId ?? 'new'} className="doc-page__body"
          unsupportedLabel="이 브라우저에서 문서 편집기를 사용할 수 없습니다."/>}
    </article>}
  </section>;
}
