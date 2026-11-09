import { useEffect, useState } from 'react';
import { Folder, FolderOpen, LoaderCircle } from 'lucide-react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Button, InlineError } from '../../ui';
import type { SpaceGrant } from '@ghost/contract';
import { canPickFolder, pickFolder } from '../../host/folderPicker';
import { pathCrumb, spaceNameFromPath } from '../../features/spacePages';
import { AccessRow, type AccessGhost } from './AccessRow';

/**
 * Creation starts from the folder: a large pick/drop target, the path it
 * fills, a name that follows the path's last segment until typed over, and
 * the Ghost access the project starts with.
 */
export function ProjectCreate({ ghosts, busy, defaultGrants, onClose, onCreate }: {
  ghosts: readonly AccessGhost[];
  busy: boolean;
  defaultGrants: SpaceGrant[];
  onClose(): void;
  onCreate(input: { name: string; path: string; grants: SpaceGrant[] }): Promise<void>;
}) {
  const [path, setPath] = useState('');
  /** While the owner has not typed a name, it follows the folder's last segment. */
  const [named, setNamed] = useState(false);
  const [name, setName] = useState('');
  const [grants, setGrants] = useState<SpaceGrant[]>(() => defaultGrants.map(grant => ({ ...grant })));
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fields, setFields] = useState<{ name?: string; path?: string }>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || picking || saving;

  const updatePath = (value: string) => {
    setPath(value);
    if (!named) setName(spaceNameFromPath(value));
  };

  useEffect(() => {
    // Drag-drop paths exist only in the desktop shell; the module loads safely anywhere.
    if (!canPickFolder) return;
    let alive = true;
    const stop = getCurrentWebview().onDragDropEvent(event => {
      if (!alive) return;
      if (event.payload.type === 'enter' || event.payload.type === 'over') setDragging(true);
      else if (event.payload.type === 'leave') setDragging(false);
      else { setDragging(false); const dropped = event.payload.paths[0]; if (dropped) updatePath(dropped); }
    });
    return () => { alive = false; void stop.then(unlisten => unlisten()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFolder = async () => {
    if (locked) return;
    setPicking(true); setError('');
    try {
      const selected = await pickFolder();
      if (selected !== null) updatePath(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPicking(false); }
  };

  const save = async () => {
    if (locked) return;
    const next: { name?: string; path?: string } = {};
    if (!name.trim()) next.name = '프로젝트 이름을 입력해 주세요.';
    if (!path.trim().startsWith('/')) next.path = '보관함 폴더의 절대 경로를 입력해 주세요.';
    setFields(next);
    if (next.name || next.path) return;
    setSaving(true); setError('');
    try {
      await onCreate({ name: name.trim(), path: path.trim(), grants });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '프로젝트를 만들지 못했습니다.');
    } finally { setSaving(false); }
  };
  const crumb = pathCrumb(path);

  return <div className="pcreate">
    {canPickFolder && (path
      ? <div className="pcreate__chosen">
        <Folder aria-hidden="true"/>
        <span className="place__crumb" title={path} aria-label={`폴더 ${path}`}>
          {crumb.leading && <span className="place__crumb-seg">{crumb.leading}</span>}
          {crumb.leading && <span className="place__crumb-gap" aria-hidden="true">…</span>}
          {crumb.trailing.map(segment => <span className="place__crumb-seg" key={segment}>{segment}</span>)}
        </span>
        <button type="button" className="pcreate__rechoose" disabled={locked} onClick={() => void chooseFolder()}>다른 폴더</button>
      </div>
      : <button type="button" className="pcreate__target" data-dragging={dragging || undefined} disabled={locked}
        onDragOver={event => event.preventDefault()}
        onDrop={event => event.preventDefault()}
        onClick={() => void chooseFolder()}>
        {picking
          ? <LoaderCircle aria-hidden="true" data-spin="true"/>
          : <FolderOpen aria-hidden="true"/>}
        <span>{dragging ? '여기에 놓기' : '폴더 선택'}</span>
      </button>)}
    <div className="pcreate__fields">
      <div className="pcreate__field">
        <label htmlFor="pcreate-path">폴더 경로</label>
        {!canPickFolder && <span className="text-caption text-ink-3">호스트 PC의 폴더 경로</span>}
        <span className="pcreate__path">
          <input id="pcreate-path" type="text" value={path} maxLength={4096} spellCheck={false} autoCapitalize="off"
            autoComplete="off" disabled={locked} aria-invalid={Boolean(fields.path) || undefined} placeholder="/Users/me/Documents/notes"
            onChange={event => updatePath(event.target.value)}/>
        </span>
        {fields.path && <p className="pcreate__invalid" role="alert">{fields.path}</p>}
      </div>
      <div className="pcreate__field">
        <label htmlFor="pcreate-name">이름</label>
        <span className="pcreate__name">
          <input id="pcreate-name" type="text" value={name} maxLength={128} disabled={locked}
            aria-invalid={Boolean(fields.name) || undefined}
            onChange={event => { setName(event.target.value); setNamed(true); }}/>
        </span>
        {fields.name && <p className="pcreate__invalid" role="alert">{fields.name}</p>}
      </div>
      <div className="pcreate__field">
        <span className="pcreate__label" id="pcreate-access">Ghost 접근</span>
        <div role="group" aria-labelledby="pcreate-access">
          <AccessRow ghosts={ghosts} grants={grants} disabled={locked} onChange={setGrants}/>
        </div>
      </div>
    </div>
    {error && <InlineError>{error}</InlineError>}
    <div className="pcreate__actions">
      <Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button>
      <Button type="button" disabled={locked} onClick={() => void save()}>만들기</Button>
    </div>
  </div>;
}
