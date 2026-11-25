import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Command, Scope, WorkbenchAgentCreate, WorkbenchAgentMove, WorkbenchFocus, WorkbenchState } from "@ghost/contract";
import type { CodingSessionsPort } from "../coding/ports.ts";
import type { Core } from "../core/core.ts";
import { configurationCommand, reviseConfiguration } from "../core/configuration.ts";
import { conflict, invalid, notFound } from "../core/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { readGit } from "../sandbox/git.ts";
import { folderChanges } from "./changes.ts";

const KEY = "workbench.state";
/** Memory key for the project-less list, 프로젝트 없음. */
const NO_PROJECT = "";
/** Whether `path` is `base` itself or inside it. */
function inside(base: string, path: string): boolean {
  const relativePath = relative(base, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** The stored shape: the published state plus each project's memory of the agent last shown in it, keyed by scope id. */
type StoredState = WorkbenchState & { remembered?: Record<string, string> };

/** A space of the pre-project workbench: a titled root folder, optionally a worktree cut from a repository. */
type StoredSpace = { id: string; title: string; root: string | null; createdAt: number; worktree?: { repo: string; branch: string } | null; lastSessionId?: string | null };
/** The state before projects replaced spaces; one release earlier still, tabs held split panes of sessions and terminals. */
type SpacesState = {
  version: number;
  spaces: StoredSpace[];
  agents?: { sessionId: string; spaceId: string }[];
  focus?: { spaceId: string; sessionId?: string | null; paneId?: string | null } | null;
  tabs?: { id: string; spaceId: string }[];
  panes?: { id: string; tabId: string; kind: string; sessionId?: string }[];
};

/** Creates a Scope exactly the way the owner's `scope.create` command does, so validation, the configuration revision and the `scope` event all happen. */
export function ownerScopeCreator(core: Core) {
  return (input: { name: string; paths: string[] }): string => {
    const command = { type: "scope.create", ...input } satisfies Command;
    return core.ledger.tx(() =>
      reviseConfiguration(core, { kind: "owner" }, command, () => configurationCommand(core, command) as { scopeId: string })).scopeId;
  };
}

/** The pre-project state normalized to spaces: tab and pane layouts collapse into one agent per session. */
function spacesOf(stored: SpacesState): { spaces: StoredSpace[]; agents: { sessionId: string; spaceId: string }[]; focus: { spaceId: string; sessionId: string | null } | null } {
  const { tabs, panes } = stored;
  if (!tabs || !panes) {
    return {
      spaces: stored.spaces,
      agents: stored.agents ?? [],
      focus: stored.focus && stored.spaces.some(space => space.id === stored.focus!.spaceId)
        ? { spaceId: stored.focus.spaceId, sessionId: stored.focus.sessionId ?? null } : null,
    };
  }
  const agents: { sessionId: string; spaceId: string }[] = [];
  for (const tab of tabs) {
    for (const pane of panes) {
      if (pane.tabId !== tab.id || pane.kind !== "session" || !pane.sessionId) continue;
      if (!agents.some(agent => agent.sessionId === pane.sessionId)) agents.push({ sessionId: pane.sessionId, spaceId: tab.spaceId });
    }
  }
  const focused = panes.find(pane => pane.id === stored.focus?.paneId);
  const sessionId = focused?.kind === "session" ? focused.sessionId ?? null : null;
  return {
    spaces: stored.spaces,
    agents,
    focus: stored.focus && stored.spaces.some(space => space.id === stored.focus!.spaceId)
      ? { spaceId: stored.focus.spaceId, sessionId: agents.some(agent => agent.sessionId === sessionId) ? sessionId : null } : null,
  };
}

export interface WorkbenchOptions {
  /** Creates the Scope for a migrated space that no project covers; without it the space maps to 프로젝트 없음. */
  createScope?: (input: { name: string; paths: string[] }) => string;
}

export class Workbench {
  constructor(
    private readonly ledger: Pick<Ledger, "setting" | "putSetting" | "tx" | "scope" | "scopes">,
    private readonly sessions: Pick<CodingSessionsPort, "get" | "list"> | null,
    private readonly options: WorkbenchOptions = {},
  ) {}

  read(): WorkbenchState {
    return this.view(this.stored());
  }

  addAgent(input: WorkbenchAgentCreate): WorkbenchState {
    return this.change(input.version, state => {
      const session = this.sessions?.get(input.sessionId);
      if (!session) throw notFound("코딩 세션을 찾을 수 없습니다.");
      this.requireScope(input.scopeId);
      const existing = state.agents.find(agent => agent.sessionId === session.id);
      if (existing && existing.scopeId !== input.scopeId) throw invalid("이 에이전트는 다른 프로젝트에 있습니다.");
      if (!existing) state.agents.push({ sessionId: session.id, scopeId: input.scopeId });
      this.select(state, input.scopeId, session.id);
    });
  }

  moveAgent(sessionId: string, input: WorkbenchAgentMove): WorkbenchState {
    return this.change(input.version, state => {
      const agent = this.agent(state, sessionId);
      this.requireScope(input.scopeId);
      if (agent.scopeId === input.scopeId) return false;
      agent.scopeId = input.scopeId;
    });
  }

  removeAgent(sessionId: string, version: number): WorkbenchState {
    return this.change(version, state => {
      const agent = this.agent(state, sessionId);
      state.agents = state.agents.filter(candidate => candidate !== agent);
      if (state.remembered) for (const scope of Object.keys(state.remembered)) if (state.remembered[scope] === sessionId) delete state.remembered[scope];
      const focus = state.focus;
      if (focus && focus.sessionId === sessionId) this.select(state, focus.scopeId);
    });
  }

  focus(input: WorkbenchFocus): WorkbenchState {
    return this.change(input.version, state => {
      const { scopeId, sessionId } = input;
      this.requireScope(scopeId);
      // Any existing session can be shown, also one a Ghost started and that is not listed as an agent.
      if (sessionId !== undefined && !this.sessions?.get(sessionId)) throw notFound("코딩 세션을 찾을 수 없습니다.");
      const shown = sessionId ?? this.remembered(state, scopeId);
      if (state.focus?.scopeId === scopeId && state.focus.sessionId === shown) return false;
      this.select(state, scopeId, shown);
    });
  }

  changes(root: string, path: string | null) {
    return folderChanges(this.allowedRoot(root), path);
  }

  /**
   * Where a new agent of the project may work: the repository holding each project path first (a project often points at
   * a repository's docs folder, while code work belongs at its top), then the path itself when it is not that top.
   */
  async folders(scopeId: string): Promise<string[]> {
    let scope: Scope;
    try { scope = this.ledger.scope(scopeId); } catch { throw notFound("프로젝트를 찾을 수 없습니다."); }
    const folders: string[] = [];
    for (const path of scope.paths) {
      const top = await readGit(path, ["rev-parse", "--show-toplevel"], 8192).catch(() => null);
      const repository = top && top.code === 0 && !top.truncated ? top.value.replace(/\n$/, "") : "";
      for (const folder of repository ? [repository, path] : [path]) if (!folders.includes(folder)) folders.push(folder);
    }
    return folders;
  }

  /** The stored state, migrating a pre-project blob once on first read. */
  private stored(): StoredState {
    const stored = this.ledger.setting<StoredState | null>(KEY, null);
    if (stored === null || !Array.isArray((stored as unknown as SpacesState).spaces)) return stored ?? { version: 0, agents: [], focus: null };
    return this.ledger.tx(() => {
      const again = this.ledger.setting<StoredState | null>(KEY, null);
      if (again === null || !Array.isArray((again as unknown as SpacesState).spaces)) return again ?? { version: 0, agents: [], focus: null };
      const next = this.migrated(again as unknown as SpacesState);
      this.ledger.putSetting(KEY, next);
      return next;
    });
  }

  /** Maps spaces to projects: the Scope covering the root, a newly created one, or 프로젝트 없음. */
  private migrated(stored: SpacesState): StoredState {
    const { spaces, agents, focus } = spacesOf(stored);
    const scopes = this.ledger.scopes();
    const mapped = new Map<string, string | null>();
    for (const space of spaces) mapped.set(space.id, this.scopeFor(space, scopes));
    const remembered: Record<string, string> = {};
    for (const space of spaces) if (space.lastSessionId) remembered[mapped.get(space.id) ?? NO_PROJECT] = space.lastSessionId;
    return {
      version: stored.version,
      agents: agents.map(agent => ({ sessionId: agent.sessionId, scopeId: mapped.get(agent.spaceId) ?? null })),
      focus: focus && { scopeId: mapped.get(focus.spaceId) ?? null, sessionId: focus.sessionId },
      ...(Object.keys(remembered).length ? { remembered } : {}),
    };
  }

  private scopeFor(space: StoredSpace, scopes: Scope[]): string | null {
    // A worktree's checkout lives inside the Host state root; the project is the repository it was cut from.
    const root = space.worktree?.repo ?? space.root;
    if (!root) return null;
    let real: string;
    try { real = realpathSync(root); } catch { return null; }
    // A project covering the folder wins; else one pointing inside it (a repository's docs folder is the same project).
    const covering = scopes.find(scope => scope.paths.some(path => inside(path, real)))
      ?? scopes.find(scope => scope.paths.some(path => inside(real, path)));
    if (covering) return covering.id;
    if (!statSync(real, { throwIfNoEntry: false })?.isDirectory() || !this.options.createScope) return null;
    const scopeId = this.options.createScope({ name: space.title.slice(0, 128), paths: [real] });
    scopes.push(this.ledger.scope(scopeId));
    return scopeId;
  }

  /** The published state: an agent or focus whose Scope was deleted reads as 프로젝트 없음. */
  private view(state: StoredState): WorkbenchState {
    const live = new Set(this.ledger.scopes().map(scope => scope.id));
    const alive = (scopeId: string | null): string | null => scopeId !== null && live.has(scopeId) ? scopeId : null;
    return {
      version: state.version,
      agents: state.agents.map(agent => ({ sessionId: agent.sessionId, scopeId: alive(agent.scopeId) })),
      focus: state.focus && { scopeId: alive(state.focus.scopeId), sessionId: state.focus.sessionId },
    };
  }

  private change(version: number, edit: (state: StoredState) => boolean | void): WorkbenchState {
    return this.ledger.tx(() => {
      const state = this.stored();
      if (state.version !== version) throw conflict("다른 곳에서 작업대를 바꿨습니다. 바뀐 배치를 불러왔으니 다시 시도하세요.");
      if (edit(state) !== false) {
        state.version++;
        this.ledger.putSetting(KEY, state);
      }
      return this.view(state);
    });
  }

  /** The agent last shown in the project, or its first listed one. */
  private remembered(state: StoredState, scopeId: string | null): string | null {
    const last = state.remembered?.[scopeId ?? NO_PROJECT];
    if (last) return last;
    return state.agents.find(agent => agent.scopeId === scopeId)?.sessionId ?? null;
  }

  private select(state: StoredState, scopeId: string | null, sessionId = this.remembered(state, scopeId)): void {
    if (sessionId) (state.remembered ??= {})[scopeId ?? NO_PROJECT] = sessionId;
    state.focus = { scopeId, sessionId };
  }

  private agent(state: StoredState, sessionId: string) {
    const agent = state.agents.find(agent => agent.sessionId === sessionId);
    if (!agent) throw notFound("에이전트를 찾을 수 없습니다.");
    return agent;
  }

  private requireScope(scopeId: string | null): void {
    if (scopeId === null) return;
    try { this.ledger.scope(scopeId); } catch { throw notFound("프로젝트를 찾을 수 없습니다."); }
  }

  /** Only a project's folder or a coding session's working folder may be inspected. */
  private allowedRoot(root: string): string {
    if (!root || !isAbsolute(root) || root.includes("\0")) throw invalid("폴더의 절대 경로를 입력하세요.");
    let resolved = root;
    try { resolved = realpathSync(root); } catch { /* Not on disk; Git will refuse it next. */ }
    if (!this.knownRoots().some(base => inside(base, root) || inside(base, resolved))) throw invalid("프로젝트 폴더 또는 코딩 세션 작업 폴더 안의 경로를 지정하세요.");
    return root;
  }

  private knownRoots(): string[] {
    return [...this.ledger.scopes().flatMap(scope => scope.paths),
      ...(this.sessions?.list() ?? []).flatMap(session => [session.cwd, ...(session.repo ? [session.repo] : [])])];
  }
}
