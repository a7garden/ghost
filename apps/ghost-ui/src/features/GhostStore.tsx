import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import type { GhostPackageCatalog, GhostPackageEntry, ModelRef, Scope, State } from '@ghost/contract';
import { Button, Checkbox, InlineError, Page, PageHeader, SettingsGroup, SkeletonRows, Switch } from '../ui';
import { useHost } from '../host/context';
import { GhostCharacter } from '../pets/GhostCharacter';
import { DotAvatar } from '../components/DotAvatar';
import { ModelChoice } from './fallbacks';
import { toolGroups } from './GhostSettings';
import { uiTerms } from '../uiText';
import './GhostSettings.css';
import './GhostStore.css';
import { ghostAddPath, ghostMakePath, packagePath } from './ghostRoutes';

/** The catalog, reloaded whenever the set of Ghosts changes so 설치됨 and the suggested projects stay true. */
function usePackages(state: State) {
  const { client } = useHost();
  const [catalog, setCatalog] = useState<GhostPackageCatalog | null>(null);
  const [error, setError] = useState('');
  const ghostKey = state.ghosts.map(ghost => `${ghost.id}:${ghost.deletedAt ?? ''}:${ghost.source?.version ?? ''}`).join(',');
  const scopeKey = state.scopes.map(scope => `${scope.id}:${scope.ghostId ?? ''}`).join(',');
  useEffect(() => {
    let alive = true;
    client.ghostPackages()
      .then(found => { if (alive) { setCatalog(found); setError(''); } })
      .catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Ghost 목록을 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [client, ghostKey, scopeKey]);
  return { catalog, error };
}

function PackagePortrait({ entry, size }: { entry: Pick<GhostPackageEntry, 'name' | 'look'>; size: number }) {
  return <GhostCharacter size={size} animate={false} color={entry.look.body} fallback="#5d6675" shape={entry.look.shape} face={entry.look.face} mark={entry.look.mark}/>;
}

/** What sets a package apart from the main Ghost: the grants it asks for, then the projects it would take. Pure; tests pin it. */
export function packageTraits(entry: Pick<GhostPackageEntry, 'tools' | 'hostExecution' | 'suggestedScopeIds' | 'installedGhostId'>): string[] {
  const traits: string[] = [];
  if (entry.hostExecution) traits.push('PC 직접 실행');
  for (const group of toolGroups) if (group.privileged && group.tools.some(tool => entry.tools.includes(tool))) traits.push(group.title);
  if (!entry.installedGhostId && entry.suggestedScopeIds.length > 0) traits.push(`프로젝트 ${entry.suggestedScopeIds.length}개를 받음`);
  return traits;
}

const firstLine = (persona: string) => persona.split('\n')[0]!.trim();

/** 「Ghost 추가」: every way of working this Host can install, each as one row leading with its portrait. */
export function GhostCatalog({ state, navigate }: { state: State; navigate(path: string): void }) {
  const { catalog, error } = usePackages(state);
  const follow = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };
  const row = (entry: GhostPackageEntry) => {
    const traits = packageTraits(entry);
    const path = packagePath(entry.name);
    return <li key={entry.name}>
      <a className="ghost-store__row" href={`#${path}`} onClick={event => follow(event, path)}>
        <span className="ghost-store__portrait"><PackagePortrait entry={entry} size={44}/></span>
        <span className="ghost-store__copy">
          <span className="ghost-store__title">{entry.title}</span>
          <span className="ghost-store__intro">{firstLine(entry.persona)}</span>
          {traits.length > 0 && <span className="ghost-store__traits">{traits.join(' · ')}</span>}
        </span>
        {entry.installedGhostId ? <span className="ghost-store__state">설치됨</span> : <ArrowRight className="ghost-store__arrow" aria-hidden="true"/>}
      </a>
    </li>;
  };
  const builtin = catalog?.packages.filter(entry => entry.origin === 'builtin') ?? [];
  const owned = catalog?.packages.filter(entry => entry.origin === 'owner') ?? [];
  return <Page width="reading" className="ghost-store">
    <PageHeader title="Ghost 추가"/>
    {error && <InlineError>{error}</InlineError>}
    {!catalog && !error && <SkeletonRows label="Ghost 목록을 불러오는 중…" rows={5}/>}
    {catalog && <>
      <ul className="ghost-store__list" aria-label="설치할 수 있는 Ghost">{builtin.map(row)}</ul>
      {owned.length > 0 && <section className="ghost-store__group" aria-labelledby="ghost-store-owned">
        <h2 id="ghost-store-owned" className="ghost-store__label">내 패키지</h2>
        <ul className="ghost-store__list">{owned.map(row)}</ul>
      </section>}
      <a className="ghost-store__make" href={`#${ghostMakePath}`} onClick={event => follow(event, ghostMakePath)}>
        <span className="ghost-store__make-mark" aria-hidden="true"><Plus/></span>
        <span className="ghost-store__copy">
          <span className="ghost-store__title">직접 만들기</span>
          <span className="ghost-store__intro">이름과 페르소나로 새 Ghost를 만듭니다</span>
        </span>
      </a>
      {catalog.errors.length > 0 && <section className="ghost-store__errors" aria-labelledby="ghost-store-errors">
        <h2 id="ghost-store-errors" className="ghost-store__label">불러오지 못한 패키지</h2>
        <ul>{catalog.errors.map(item => <li key={item.path}><code>{item.path}</code> {item.message}</li>)}</ul>
      </section>}
    </>}
  </Page>;
}

/** Projects the main Ghost receives: unassigned ones and those addressed to it. */
function mainProjects(state: State): Scope[] {
  const main = state.ghosts.find(ghost => ghost.isDefault)?.id;
  return state.scopes.filter(scope => scope.ghostId === null || scope.ghostId === main);
}

/** One package before installing: the projects it takes, the model, what it may do and how it works. */
export function GhostInstall({ state, name, navigate }: { state: State; name: string; navigate(path: string): void }) {
  const { catalog, error: loadError } = usePackages(state);
  const entry = catalog?.packages.find(item => item.name === name);
  if (loadError) return <Page width="reading"><PageHeader title="Ghost 추가"/><InlineError>{loadError}</InlineError></Page>;
  if (!catalog) return <Page width="reading"><SkeletonRows label="패키지를 불러오는 중…" rows={6}/></Page>;
  if (!entry) return <Page width="reading"><PageHeader title="이 Ghost를 찾을 수 없습니다"/>
    <Button variant="outline" onClick={() => navigate(ghostAddPath)}>Ghost 추가</Button></Page>;
  return <InstallSheet key={entry.name} entry={entry} state={state} navigate={navigate}/>;
}

function InstallSheet({ entry, state, navigate }: { entry: GhostPackageEntry; state: State; navigate(path: string): void }) {
  const { client } = useHost();
  const send = client.send.bind(client);
  const installed = entry.installedGhostId ? state.ghosts.find(ghost => ghost.id === entry.installedGhostId) : undefined;
  const projects = mainProjects(state);
  const [name, setName] = useState(entry.title);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [hostExecution, setHostExecution] = useState(entry.hostExecution);
  const [picked, setPicked] = useState(() => new Set(entry.suggestedScopeIds));
  const [choosing, setChoosing] = useState(entry.suggestedScopeIds.length > 0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const skills = entry.skills.filter(skill => !entry.missingSkills.includes(skill));
  const groups = toolGroups.filter(group => group.tools.some(tool => entry.tools.includes(tool)));
  const [intro, ...rest] = entry.persona.split('\n');
  const body = rest.join('\n').trim();

  const install = async () => {
    if (pending || !name.trim()) return;
    setPending(true); setError('');
    let ghostId = created;
    try {
      if (!ghostId) {
        const result = await send<{ ghostId?: string }>({ type: 'ghost.create', package: entry.name, name: name.trim(), skills, hostExecution, ...(model ? { model } : {}) });
        if (!result.ghostId) throw new Error('설치한 Ghost를 찾지 못했습니다.');
        ghostId = result.ghostId;
        setCreated(ghostId);
      }
      const failed: string[] = [];
      for (const scope of projects) {
        if (!picked.has(scope.id)) continue;
        try { await send({ type: 'scope.update', scopeId: scope.id, ghostId }); }
        catch { failed.push(scope.name); }
      }
      if (failed.length) { setError(`설치했지만 옮기지 못한 프로젝트가 있습니다: ${failed.join(', ')}`); return; }
      navigate(`/ghosts/${encodeURIComponent(ghostId)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '설치하지 못했습니다.');
    } finally { setPending(false); }
  };

  const toggle = (id: string, on: boolean) => setPicked(current => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const head = <header className="ghost-install__head">
    <span className="ghost-install__portrait">{installed ? <DotAvatar profileId={installed.id} size={72}/> : <PackagePortrait entry={entry} size={72}/>}</span>
    <div className="ghost-install__who">
      {installed || created ? <h1 className="ghost-install__name">{installed?.name ?? name}</h1>
        : <input className="ghost-install__name" aria-label="이름" value={name} maxLength={128} disabled={pending} onChange={event => setName(event.target.value)}/>}
      <p className="ghost-install__intro">{intro}</p>
    </div>
  </header>;

  const ways = <>
    <Fact label="할 수 있는 일">
      <span className="ghost-install__tools">{groups.map((group, index) => <Fragment key={group.title}>
        {index > 0 && ', '}<span data-privileged={group.privileged || undefined}>{group.title}</span>
      </Fragment>)}</span>
    </Fact>
    {(skills.length > 0 || entry.missingSkills.length > 0) && <Fact label="스킬">
      {skills.length > 0 && <span className="ghost-install__mono">{skills.join(', ')}</span>}
      {entry.missingSkills.length > 0 && <small className="ghost-install__note">이 Host에 없어서 빠집니다: {entry.missingSkills.join(', ')}</small>}
    </Fact>}
    {body && <Fact label="일하는 방식"><p className="ghost-install__persona">{body}</p></Fact>}
  </>;

  if (installed && !created) return <Page width="reading" className="ghost-install">
    {head}
    <div className="ghost-install__actions">
      <Button onClick={() => navigate(`/ghosts/${encodeURIComponent(installed.id)}`)}>대화 열기</Button>
      <Button variant="outline" onClick={() => navigate(`/settings?tab=team&ghost=${encodeURIComponent(installed.id)}`)}>{uiTerms.ghostSettings}</Button>
    </div>
    <dl className="ghost-install__facts">{ways}</dl>
  </Page>;

  return <Page width="reading" className="ghost-install">
    <form onSubmit={event => { event.preventDefault(); void install(); }}>
      {head}
      <dl className="ghost-install__facts">
        {projects.length > 0 && <Fact label="맡을 프로젝트">
          {choosing ? <fieldset className="ghost-install__projects" disabled={pending || Boolean(created)}>
            <legend className="sr-only">메인에서 옮겨 올 프로젝트</legend>
            {projects.map(scope => <label key={scope.id} className="ghost-install__project">
              <Checkbox checked={picked.has(scope.id)} onCheckedChange={value => toggle(scope.id, value === true)}/>
              <span className="truncate">{scope.name}</span>
              {entry.suggestedScopeIds.includes(scope.id) && <span className="ghost-install__suggested">{entry.projects === 'code' ? '저장소' : '문서'}</span>}
            </label>)}
            <small className="ghost-install__note">고른 프로젝트는 메인에서 이 Ghost로 옮겨 옵니다. 프로젝트 설정에서 언제든 되돌릴 수 있습니다.</small>
          </fieldset>
            : <button type="button" className="ghost-install__expand" onClick={() => setChoosing(true)}><Plus aria-hidden="true"/>메인의 프로젝트 가져오기</button>}
        </Fact>}
        <Fact label="모델">
          <ModelChoice label="모델" value={model} disabled={pending || Boolean(created)} onChange={setModel}/>
          {entry.modelHint && <small className="ghost-install__note">권장: {entry.modelHint}</small>}
        </Fact>
        {entry.hostExecution && <Fact label="PC 직접 실행">
          <span className="ghost-install__grant">
            <Switch checked={hostExecution} disabled={pending || Boolean(created)} aria-label="PC 직접 실행 허용" onCheckedChange={setHostExecution}/>
            <small className="ghost-install__note" data-tone={hostExecution ? 'warning' : undefined}>{hostExecution
              ? '이 Ghost의 일이 보호 장치 없이 이 Mac의 파일과 명령을 직접 실행합니다.'
              : '끄면 PC가 필요한 일은 이 Ghost가 허용을 요청합니다.'}</small>
          </span>
        </Fact>}
        {ways}
      </dl>
      {error && <InlineError>{error}</InlineError>}
      <div className="ghost-install__actions">
        {created
          ? <Button type="button" onClick={() => navigate(`/ghosts/${encodeURIComponent(created)}`)}>대화 열기</Button>
          : <Button type="submit" disabled={pending || !name.trim()}>{pending ? '설치하는 중…' : '설치'}</Button>}
        {created && <Button type="submit" variant="outline" disabled={pending}>다시 옮기기</Button>}
      </div>
    </form>
  </Page>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ghost-install__fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

/** 직접 만들기: the portrait it will get, its name and its persona; the rest is set on its sheet afterwards. */
export function GhostMake({ navigate }: { navigate(path: string): void }) {
  const { client } = useHost();
  const [name, setName] = useState(''), [persona, setPersona] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const create = async () => {
    if (!name.trim() || !persona.trim() || saving) return;
    setSaving(true); setError('');
    try {
      const created = await client.send<{ ghostId?: string }>({ type: 'ghost.create', name: name.trim(), persona });
      navigate(created.ghostId ? `/settings?tab=team&ghost=${encodeURIComponent(created.ghostId)}` : '/settings?tab=team');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ghost를 만들지 못했습니다.'); setSaving(false); }
  };
  return <Page width="reading">
    <form className="ghost-sheet ghost-sheet--new" onSubmit={event => { event.preventDefault(); void create(); }}>
      <header className="ghost-sheet__identity">
        <span className="ghost-sheet__portrait" aria-hidden="true"><DotAvatar profileId={`new:${name}`} size={48}/></span>
        <div className="ghost-sheet__who">
          <input className="ghost-sheet__name" aria-label="이름" placeholder="이름" value={name} maxLength={128} autoFocus required disabled={saving} onChange={event => setName(event.target.value)}/>
        </div>
      </header>
      <SettingsGroup title={uiTerms.persona} className="ghost-panel">
        <div className="persona-note"><textarea aria-label={uiTerms.persona} placeholder="첫 줄은 한 줄 소개. 이어서 말투, 좋은 결과의 기준, 혼자 정할 것과 물을 것" value={persona} rows={6} maxLength={8192} required disabled={saving} onChange={event => setPersona(event.target.value)}/></div>
      </SettingsGroup>
      {error && <InlineError>{error}</InlineError>}
      <div className="ghost-sheet__footer">
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => navigate(ghostAddPath)}>취소</Button>
        <Button type="submit" size="sm" disabled={saving || !name.trim() || !persona.trim()}>{saving ? '만드는 중…' : '만들기'}</Button>
      </div>
    </form>
  </Page>;
}
