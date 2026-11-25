import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent, Space, WorkbenchAgentCreate, WorkbenchFocus, WorkbenchSpaceCreate, WorkbenchState } from "@ghost/contract";
import type { CodingSessionsPort } from "../coding/ports.ts";
import { conflict, invalid, notFound } from "../core/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { createWorktree, repositoryOf } from "../sandbox/worktree.ts";
import { spaceChanges } from "./changes.ts";

const KEY = "workbench.state";
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw notFound(message);
  return value;
}
function title(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw invalid("이름을 입력하세요.");
  return trimmed;
}
function directory(path: string): string {
  if (!isAbsolute(path) || path.includes("\0") || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw invalid("Mac에 있는 폴더의 절대 경로를 입력하세요.");
  return path;
}

/** The state before 2.34: tabs held split panes of sessions and terminals. Only session panes survive as agents. */
type StoredState = Partial<WorkbenchState> & Pick<WorkbenchState, "version" | "spaces"> & {
  tabs?: { id: string; spaceId: string }[];
  panes?: { id: string; tabId: string; kind: string; sessionId?: string }[];
  focus?: { spaceId: string; sessionId?: string | null; paneId?: string | null } | null;
};

function current(stored: StoredState): WorkbenchState {
  const { tabs, panes } = stored;
  if (!tabs || !panes) return { version: stored.version, spaces: stored.spaces, agents: stored.agents ?? [], focus: stored.focus ? { spaceId: stored.focus.spaceId, sessionId: stored.focus.sessionId ?? null } : null };
  const agents: Agent[] = [];
  for (const tab of tabs) {
    for (const pane of panes) {
      if (pane.tabId !== tab.id || pane.kind !== "session" || !pane.sessionId) continue;
      if (!agents.some(agent => agent.sessionId === pane.sessionId)) agents.push({ sessionId: pane.sessionId, spaceId: tab.spaceId });
    }
  }
  const focused = panes.find(pane => pane.id === stored.focus?.paneId);
  const sessionId = focused?.kind === "session" ? focused.sessionId ?? null : null;
  return {
    version: stored.version,
    spaces: stored.spaces,
    agents,
    focus: stored.focus && stored.spaces.some(space => space.id === stored.focus!.spaceId)
      ? { spaceId: stored.focus.spaceId, sessionId: agents.some(agent => agent.sessionId === sessionId) ? sessionId : null } : null,
  };
}

export class Workbench {
  constructor(
    private readonly ledger: Pick<Ledger, "setting" | "putSetting" | "tx">,
    private readonly sessions: Pick<CodingSessionsPort, "get"> | null,
    private readonly stateRoot: string,
  ) {}

  read(): WorkbenchState {
    return current(this.ledger.setting<StoredState>(KEY, { version: 0, spaces: [] }));
  }

  private change(version: number, edit: (state: WorkbenchState) => boolean | void): WorkbenchState {
    return this.ledger.tx(() => {
      const state = this.read();
      if (state.version !== version) throw conflict("다른 곳에서 작업대를 바꿨습니다. 바뀐 배치를 불러왔으니 다시 시도하세요.");
      if (edit(state) !== false) {
        state.version++;
        this.ledger.putSetting(KEY, state);
      }
      return state;
    });
  }

  createSpace(input: WorkbenchSpaceCreate): WorkbenchState {
    return this.change(input.version, state => {
      const space: Space = { id: crypto.randomUUID(), title: title(input.title), root: input.root === null ? null : directory(input.root), createdAt: Date.now() };
      if (input.worktree) {
        if (!space.root) throw invalid("worktree를 만들 Git 저장소를 선택하세요.");
        let repo: string;
        try { repo = repositoryOf(space.root); } catch { throw invalid("커밋이 있는 Git 저장소를 선택하세요."); }
        const branch = input.worktree.branch.trim();
        const parent = join(this.stateRoot, "workbench-worktrees");
        try {
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          space.root = createWorktree(repo, join(parent, space.id), branch);
        } catch (error) {
          throw invalid(error instanceof Error ? error.message : "worktree를 만들지 못했습니다.");
        }
        space.worktree = { repo, branch };
      }
      state.spaces.push(space);
      this.select(state, space.id);
    });
  }

  changes(id: string, path: string | null) {
    return spaceChanges(this.space(this.read(), id).root, path);
  }

  renameSpace(id: string, version: number, nextTitle: string): WorkbenchState {
    return this.change(version, state => {
      const space = this.space(state, id);
      const next = title(nextTitle);
      if (space.title === next) return false;
      space.title = next;
    });
  }

  deleteSpace(id: string, version: number): WorkbenchState {
    return this.change(version, state => {
      this.space(state, id);
      state.spaces = state.spaces.filter(space => space.id !== id);
      state.agents = state.agents.filter(agent => agent.spaceId !== id);
      if (state.focus?.spaceId !== id) return;
      const next = state.spaces[0];
      if (next) this.select(state, next.id);
      else state.focus = null;
    });
  }

  addAgent(spaceId: string, input: WorkbenchAgentCreate): WorkbenchState {
    return this.change(input.version, state => {
      this.space(state, spaceId);
      const session = this.sessions?.get(input.sessionId);
      if (!session) throw notFound("코딩 세션을 찾을 수 없습니다.");
      const existing = state.agents.find(agent => agent.sessionId === session.id);
      if (existing && existing.spaceId !== spaceId) throw invalid("이 에이전트는 다른 스페이스에 있습니다.");
      if (!existing) state.agents.push({ sessionId: session.id, spaceId });
      this.select(state, spaceId, session.id);
    });
  }

  removeAgent(sessionId: string, version: number): WorkbenchState {
    return this.change(version, state => {
      const agent = this.agent(state, sessionId);
      state.agents = state.agents.filter(candidate => candidate !== agent);
      const space = this.space(state, agent.spaceId);
      if (space.lastSessionId === sessionId) delete space.lastSessionId;
      if (state.focus?.sessionId === sessionId) this.select(state, agent.spaceId);
    });
  }

  focus(input: WorkbenchFocus): WorkbenchState {
    return this.change(input.version, state => {
      const { spaceId, sessionId } = input;
      this.space(state, spaceId);
      if (sessionId && this.agent(state, sessionId).spaceId !== spaceId) throw invalid("이 스페이스의 에이전트가 아닙니다.");
      const focused = sessionId ?? this.remembered(state, spaceId);
      if (state.focus?.spaceId === spaceId && state.focus.sessionId === focused) return false;
      this.select(state, spaceId, focused);
    });
  }

  /** The agent last shown in the space, or its first one. */
  private remembered(state: WorkbenchState, spaceId: string): string | null {
    const last = this.space(state, spaceId).lastSessionId;
    if (last && state.agents.some(agent => agent.sessionId === last && agent.spaceId === spaceId)) return last;
    return state.agents.find(agent => agent.spaceId === spaceId)?.sessionId ?? null;
  }

  private select(state: WorkbenchState, spaceId: string, sessionId = this.remembered(state, spaceId)): void {
    const space = this.space(state, spaceId);
    if (sessionId) space.lastSessionId = sessionId;
    state.focus = { spaceId, sessionId };
  }

  private space(state: WorkbenchState, id: string) { return required(state.spaces.find(space => space.id === id), "스페이스를 찾을 수 없습니다."); }
  private agent(state: WorkbenchState, sessionId: string) { return required(state.agents.find(agent => agent.sessionId === sessionId), "에이전트를 찾을 수 없습니다."); }
}
