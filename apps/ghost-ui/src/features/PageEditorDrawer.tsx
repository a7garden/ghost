import { useEffect, useState } from 'react';
import { Badge, Button, FormField, InlineError, Input, SegmentedControl, SelectField, Textarea } from '../ui';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import '../editor/styles.css';
import type { PageView } from '@ghost/contract';
import { useHost } from '../host/context';
import { isConflict, isEditableProfile } from './spacePages';
import type { EditableProfile } from './spacePages';
import { Modal } from '../components/Modal';

const MAX_BODY_BYTES = 1_048_576;
const EMPTY_DRAFT = { title: '', body: '', profile: 'pdc-markdown/1' as EditableProfile };

/** One page in a drawer: legacy profiles read-only, edits guarded by the content hash. */
export function PageEditorDrawer({ scopeId, pageId, onClose, onSaved }: {
  scopeId: string;
  /** null creates a new page. */
  pageId: string | null;
  onClose(): void;
  /** Refreshes the document list after a save. */
  onSaved(): void;
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
  const load = (targetId: string) => {
    setLoading(true); setLoadError('');
    client.page(scopeId, targetId).then(page => {
      setView(page);
      setDraft({ title: page.title, body: page.body, profile: isEditableProfile(page.profile) ? page.profile : 'pdc-markdown/1' });
      setHash(page.hash);
      setConflict(false);
      setError('');
    }).catch(reason => setLoadError(reason instanceof Error ? reason.message : '문서를 불러오지 못했습니다.')).finally(() => setLoading(false));
  };
  useEffect(() => { if (pageId !== null) load(pageId); }, [pageId, scopeId]);
  const editable = view === null ? true : isEditableProfile(view.profile);
  const dirty = !view || draft.title !== view.title || draft.body !== view.body || (isEditableProfile(view.profile) && draft.profile !== view.profile);
  const save = async () => {
    if (saving || !dirty) return;
    if (!draft.title.trim()) { setError('문서 제목을 입력해 주세요.'); return; }
    if (new TextEncoder().encode(draft.body).length > MAX_BODY_BYTES) { setError('저장할 내용이 너무 큽니다.'); return; }
    setSaving(true); setError('');
    try {
      const result = await client.send<{ pageId: string; hash: string }>({
        type: 'document.save',
        scopeId,
        pageId: view?.pageId ?? null,
        expectedHash: view ? hash : null,
        title: draft.title.trim(),
        body: draft.body,
        ...(view ? {} : { profile: draft.profile }),
      });
      setHash(result.hash);
      if (!view) { setView({ pageId: result.pageId, locator: '', title: draft.title.trim(), profile: draft.profile, body: draft.body, hash: result.hash }); }
      else setView(current => current ? { ...current, title: draft.title.trim(), body: draft.body, hash: result.hash } : current);
      setConflict(false);
      onSaved();
    } catch (reason) {
      if (isConflict(reason)) {
        setConflict(true);
        setError('문서가 다른 곳에서 바뀌었습니다. 저장하지 못했습니다.');
      } else {
        setError(reason instanceof Error ? reason.message : '문서를 저장하지 못했습니다.');
      }
    } finally { setSaving(false); }
  };
  const reload = () => {
    if (view) load(view.pageId);
    else { setDraft(EMPTY_DRAFT); setHash(null); setConflict(false); setError(''); }
  };
  return <Modal title={view ? draft.title || '제목 없음' : '새 문서'} onClose={onClose} drawer focusClose className="sm:max-w-[760px]">
    <div className="grid gap-4">
      {loading && <p className="m-0 text-ui text-ink-2" role="status">문서를 불러오는 중…</p>}
      {loadError && <InlineError>{loadError}</InlineError>}
      {!loading && !loadError && <>
        {view && !editable && <p className="m-0 flex items-center gap-2 text-caption text-ink-2"><Badge variant="outline">읽기 전용</Badge>이전 형식({view.profile})의 문서는 이 화면에서 고칠 수 없습니다.</p>}
        {conflict && <div className="grid gap-2 rounded-control bg-inset p-3">
          <InlineError>{error}</InlineError>
          <p className="m-0 text-caption text-ink-2">다시 불러오면 이 화면에서 고친 내용을 지우고 저장된 문서를 새로 읽어 옵니다.</p>
          <div><Button variant="outline" type="button" onClick={reload}>다시 불러오기</Button></div>
        </div>}
        <FormField label="제목">
          {control => <Input {...control} value={draft.title} required maxLength={512} disabled={!editable || saving} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}/>}
        </FormField>
        {!view && <FormField label="형식" description="마크다운 문서나 HTML 문서로 새로 만듭니다.">
          {control => <SelectField {...control} label="형식" value={draft.profile} disabled={saving} onValueChange={profile => setDraft(current => ({ ...current, profile: profile as EditableProfile }))}
            options={[{ value: 'pdc-markdown/1', label: '마크다운 (pdc-markdown/1)' }, { value: 'pdc-html/1', label: 'HTML (pdc-html/1)' }]}/>}
        </FormField>}
        {isEditableProfile(draft.profile) && draft.profile === 'pdc-html/1'
          ? <section className="grid gap-3">
            <SegmentedControl aria-label="HTML 표시 방식" value={htmlView} onValueChange={value => setHtmlView(value as 'preview' | 'source')}
              options={[{ value: 'preview', label: '미리보기' }, { value: 'source', label: '원문' }]}/>
            {htmlView === 'preview'
              ? <iframe title="HTML 미리보기" sandbox="" referrerPolicy="no-referrer" className="min-h-[50dvh] w-full rounded-xl border-0 bg-surface shadow-card"
                srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">${draft.body}`}/>
              : <FormField label="본문">
                {control => <Textarea {...control} value={draft.body} rows={16} disabled={!editable || saving} className="min-h-[50dvh] font-mono text-caption" spellCheck={false}
                  onChange={event => setDraft(current => ({ ...current, body: event.target.value }))}/>}
              </FormField>}
          </section>
          : <div className="grid gap-1 rounded-xl bg-surface p-1 shadow-card">
            <MarkdownEditor value={draft.body} onChange={body => setDraft(current => ({ ...current, body }))}
              label="본문" readOnly={!editable || saving} documentId={view?.pageId ?? 'new'} className="min-h-[50dvh]"
              unsupportedLabel="이 브라우저에서 문서 편집기를 사용할 수 없습니다."/>
          </div>}
        {!conflict && error && <InlineError>{error}</InlineError>}
        {editable && <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" disabled={saving} onClick={onClose}>닫기</Button>
          <Button type="button" disabled={saving || !dirty || !draft.title.trim()} onClick={() => void save()}>{saving ? '저장 중…' : dirty ? '저장' : '저장됨'}</Button>
        </div>}
      </>}
    </div>
  </Modal>;
}
export default PageEditorDrawer;
