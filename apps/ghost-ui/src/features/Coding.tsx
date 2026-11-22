import { useEffect, useReducer } from 'react';
import { Plus } from 'lucide-react';
import type { Scope } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useCodingPageSetup } from './CodingSetup';
import { NewHerdrWorkspace } from './HerdrStart';
import { HerdrRoster, OpenHerdrPane, useHerdr } from './Herdr';
import { parseHerdrPane } from './herdrDisplay';
import './coding.css';

export function CodingPage({ scopes, herdrPane, creating, onStarted, onCancel, compact }: {
  scopes: Scope[]; herdrPane: string | null; creating: boolean; compact: boolean;
  onStarted(id: string): void; onCancel(): void;
}) {
  const showDetail = creating || herdrPane !== null;
  const [revision, refresh] = useReducer((count: number) => count + 1, 0);
  const { setup, required, panel, errors, refreshSetup } = useCodingPageSetup(!compact || !showDetail, () => {
    if (!creating && herdrPane !== null) onCancel();
    refresh();
  });
  const { view, error } = useHerdr(revision);
  const roster = setup && view?.session !== setup.session ? null : view;
  const pane = parseHerdrPane(herdrPane);
  const sessionChanged = Boolean(setup && view && setup.session !== view.session);
  const needsSetup = sessionChanged || Boolean(setup && !required && (view?.available === false || view?.note));
  // A ready setup stops polling; the roster can tell us the server stopped or the owner switched sessions.
  useEffect(() => {
    if (needsSetup) refreshSetup();
  }, [needsSetup, refreshSetup]);
  useEffect(() => {
    if (sessionChanged && !creating && pane) onCancel();
  }, [sessionChanged, creating, pane, onCancel]);
  const showSetupInRoster = (compact && !showDetail) || (!compact && !required);
  const setupNotice = <>{errors}{panel}</>;
  const paneSession = setup?.session ?? roster?.session;
  const paneUnavailable = setup && (!setup.herdr.path || !setup.server || !setup.server.compatible || !setup.config.ok);
  return <div className="coding-page" data-compact={compact || undefined} data-detail={showDetail || undefined}>
    <section className="coding-roster" aria-label="코딩 세션">
      <header className="coding-roster-head">
        <h1>코딩</h1>
        <Button asChild variant={creating ? 'secondary' : 'default'}>
          <a href="#/coding?new=1" aria-current={creating ? 'page' : undefined}><Plus aria-hidden="true"/>새 코딩 세션</a>
        </Button>
      </header>
      <div className="coding-roster-scroll">
        {!required && !errors && (error || roster?.note) && <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error || roster?.note}</InlineError>}
        {!required && !errors && !error && !roster && <p role="status" className="coding-hint">세션을 불러오는 중…</p>}
        {!required && roster?.available && !roster.note && !roster.panes.length && <p className="coding-hint">herdr에 열린 에이전트가 없습니다.</p>}
        {required && showSetupInRoster && setupNotice}
        {roster?.available && <HerdrRoster panes={roster.panes} selected={creating ? null : pane}/>}
        {!required && showSetupInRoster && setupNotice}
      </div>
    </section>
    {showDetail ? <div className="coding-pane">
      {(required || (compact && errors)) && <div className="coding-pane-setup">{errors}{required && panel}</div>}
      {creating ? <NewHerdrWorkspace scopes={scopes} setup={setup} onCancel={onCancel}
        onStarted={started => { refresh(); onStarted(started.id); }}/>
        : !pane ? <div className="coding-pane-status"><InlineError>herdr 패널 주소가 올바르지 않습니다.</InlineError></div>
        : paneUnavailable || sessionChanged ? null
        : paneSession ? <OpenHerdrPane key={`${paneSession}/${pane}`} pane={pane} onChanged={refresh}/>
        : !errors && <div className="coding-pane-status">{error
          ? <InlineError onRetry={refresh} retryLabel="다시 불러오기">{error}</InlineError>
          : <p role="status">터미널을 불러오는 중…</p>}</div>}
    </div> : !compact && <div className={`coding-pane ${required ? 'coding-pane-setup' : 'coding-unselected'}`}>
      {required ? setupNotice : Boolean(roster?.panes.length) && <p className="coding-hint">에이전트를 선택하세요.</p>}
    </div>}
  </div>;
}
