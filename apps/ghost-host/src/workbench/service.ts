import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { Pane, Space, Tab, WorkbenchFocus, WorkbenchPaneCreate, WorkbenchSpaceCreate, WorkbenchState, WorkbenchTerminalBinding } from "@ghost/contract";
import type { CodingSessionsPort } from "../coding/ports.ts";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { closePane, firstPane, movePane, resizeSplit, splitPane } from "./layout.ts";
import type { WorkbenchTerminals } from "./ports.ts";

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

export class Workbench {
  private readonly terminalIds = new Map<string, string>();
  private readonly opening = new Map<string, Promise<WorkbenchTerminalBinding>>();
  private removing: ReadonlySet<string> | null = null;

  constructor(
    private readonly ledger: Pick<Ledger, "setting" | "putSetting" | "tx">,
    private readonly sessions: Pick<CodingSessionsPort, "get"> | null,
    private readonly terminals: WorkbenchTerminals | null,
  ) {}

  read(): WorkbenchState {
    return this.ledger.setting<WorkbenchState>(KEY, { version: 0, spaces: [], tabs: [], panes: [], focus: null });
  }

  private change(version: number, edit: (state: WorkbenchState) => boolean | void): WorkbenchState {
    return this.ledger.tx(() => {
      const state = this.atVersion(version);
      if (edit(state) !== false) this.save(state);
      return state;
    });
  }

  private atVersion(version: number): WorkbenchState {
    if (this.removing) throw conflict("터미널을 종료하고 있습니다. 잠시 후 다시 시도하세요.");
    const state = this.read();
    if (state.version !== version) throw conflict("다른 곳에서 작업대를 바꿨습니다. 바뀐 배치를 불러왔으니 다시 시도하세요.");
    return state;
  }

  private save(state: WorkbenchState): WorkbenchState {
    state.version++;
    this.ledger.putSetting(KEY, state);
    return state;
  }

  private async remove(version: number, edit: (state: WorkbenchState, removed: Set<string>) => void): Promise<WorkbenchState> {
    const state = this.atVersion(version);
    const removed = new Set<string>();
    edit(state, removed);
    if (!removed.size) return this.save(state);
    // Keep the old layout on close failure. Do not permit a writer or a restart to race the removal.
    this.removing = removed;
    try {
      const results = await Promise.allSettled([...removed].map(async paneId => {
        const id = this.terminalIds.get(paneId);
        if (!id) return;
        await this.terminals?.closeTerminal(id);
        this.terminalIds.delete(paneId);
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      return this.save(state);
    } finally {
      this.removing = null;
    }
  }

  createSpace(input: WorkbenchSpaceCreate): WorkbenchState {
    return this.change(input.version, state => {
      const space: Space = { id: crypto.randomUUID(), title: title(input.title), root: input.root === null ? null : directory(input.root), createdAt: Date.now() };
      state.spaces.push(space);
      this.select(state, space.id);
    });
  }

  renameSpace(id: string, version: number, nextTitle: string): WorkbenchState {
    return this.change(version, state => {
      const space = this.space(state, id);
      const next = title(nextTitle);
      if (space.title === next) return false;
      space.title = next;
    });
  }

  deleteSpace(id: string, version: number): Promise<WorkbenchState> {
    return this.remove(version, (state, removed) => {
      this.space(state, id);
      const tabs = new Set(state.tabs.filter(tab => tab.spaceId === id).map(tab => tab.id));
      state.spaces = state.spaces.filter(space => space.id !== id);
      state.tabs = state.tabs.filter(tab => !tabs.has(tab.id));
      state.panes = state.panes.filter(pane => {
        if (!tabs.has(pane.tabId)) return true;
        if (pane.kind === "terminal") removed.add(pane.id);
        return false;
      });
      if (state.focus?.spaceId === id) {
        const space = state.spaces[0];
        if (space) this.select(state, space.id, state.tabs.find(tab => tab.spaceId === space.id));
        else state.focus = null;
      }
    });
  }

  createTab(spaceId: string, version: number, name: string): WorkbenchState {
    return this.change(version, state => {
      this.space(state, spaceId);
      const tab: Tab = { id: crypto.randomUUID(), spaceId, title: title(name), layout: null, focusedPaneId: null };
      state.tabs.push(tab);
      this.select(state, spaceId, tab);
    });
  }

  renameTab(id: string, version: number, nextTitle: string): WorkbenchState {
    return this.change(version, state => {
      const tab = this.tab(state, id);
      const next = title(nextTitle);
      if (tab.title === next) return false;
      tab.title = next;
    });
  }

  deleteTab(id: string, version: number): Promise<WorkbenchState> {
    return this.remove(version, (state, removed) => {
      const tab = this.tab(state, id);
      state.tabs = state.tabs.filter(tab => tab.id !== id);
      state.panes = state.panes.filter(pane => {
        if (pane.tabId !== id) return true;
        if (pane.kind === "terminal") removed.add(pane.id);
        return false;
      });
      if (state.focus?.tabId === id) this.select(state, tab.spaceId, state.tabs.find(candidate => candidate.spaceId === tab.spaceId));
    });
  }

  addPane(tabId: string, input: WorkbenchPaneCreate): WorkbenchState {
    return this.change(input.version, state => {
      const tab = this.tab(state, tabId);
      const id = crypto.randomUUID();
      if (Boolean(input.targetPaneId) !== Boolean(input.direction)) throw invalid("분할할 패널과 방향을 선택하세요.");
      const layout = splitPane(tab.layout, id, input.targetPaneId && input.direction ? {
        target: input.targetPaneId, id: crypto.randomUUID(), direction: input.direction,
      } : undefined);
      let pane: Pane;
      if (input.pane.kind === "session") {
        const session = this.sessions?.get(input.pane.sessionId);
        if (!session) throw notFound("코딩 세션을 찾을 수 없습니다.");
        pane = { id, tabId, kind: "session", sessionId: session.id };
      } else {
        const terminalSpec = input.pane.terminalSpec ?? { cwd: this.space(state, tab.spaceId).root ?? homedir() };
        pane = { id, tabId, kind: "terminal", terminalSpec: { ...terminalSpec, cwd: directory(terminalSpec.cwd) } };
      }
      state.panes.push(pane);
      tab.layout = layout;
      this.select(state, tab.spaceId, tab, id);
    });
  }

  deletePane(id: string, version: number): Promise<WorkbenchState> {
    return this.remove(version, (state, removed) => {
      const pane = this.pane(state, id);
      const tab = this.tab(state, pane.tabId);
      if (pane.kind === "terminal") removed.add(id);
      tab.layout = closePane(tab.layout, id);
      if (tab.focusedPaneId === id) tab.focusedPaneId = firstPane(tab.layout);
      state.panes = state.panes.filter(pane => pane.id !== id);
      if (state.focus?.tabId === tab.id) this.select(state, tab.spaceId, tab);
    });
  }

  resize(tabId: string, splitId: string, version: number, ratio: number): WorkbenchState {
    return this.change(version, state => {
      const tab = this.tab(state, tabId);
      const next = resizeSplit(tab.layout, splitId, ratio);
      if (next === tab.layout) return false;
      tab.layout = next;
    });
  }

  move(id: string, targetId: string, version: number): WorkbenchState {
    return this.change(version, state => {
      const pane = this.pane(state, id), target = this.pane(state, targetId);
      if (pane.tabId !== target.tabId) throw invalid("같은 탭 안에서만 패널을 옮길 수 있습니다.");
      const tab = this.tab(state, pane.tabId);
      if (id === targetId) return false;
      if (!tab.layout) throw notFound("옮길 패널을 찾을 수 없습니다.");
      tab.layout = movePane(tab.layout, id, targetId);
      this.select(state, tab.spaceId, tab, id);
    });
  }

  focus(input: WorkbenchFocus): WorkbenchState {
    return this.change(input.version, state => {
      const { spaceId, tabId, paneId } = input;
      this.space(state, spaceId);
      const tab = tabId ? this.tab(state, tabId) : state.tabs.find(candidate => candidate.id === state.focus?.tabId && candidate.spaceId === spaceId)
        ?? state.tabs.find(candidate => candidate.spaceId === spaceId);
      if (tab && tab.spaceId !== spaceId) throw invalid("이 스페이스의 탭이 아닙니다.");
      if (paneId && this.pane(state, paneId).tabId !== tab?.id) throw invalid("이 탭의 패널이 아닙니다.");
      const focusedPane = paneId ?? tab?.focusedPaneId ?? null;
      if (state.focus?.spaceId === spaceId && state.focus.tabId === (tab?.id ?? null) && state.focus.paneId === focusedPane) return false;
      this.select(state, spaceId, tab, focusedPane);
    });
  }

  focusTerminal(id: string, version: number): WorkbenchState {
    for (const [paneId, terminalId] of this.terminalIds) {
      if (terminalId !== id) continue;
      const state = this.read();
      const tab = this.tab(state, this.pane(state, paneId).tabId);
      return this.focus({ version, spaceId: tab.spaceId, tabId: tab.id, paneId });
    }
    throw notFound("이 터미널은 더 이상 열려 있지 않습니다.");
  }

  private select(state: WorkbenchState, spaceId: string, tab?: Tab, paneId = tab?.focusedPaneId ?? null): void {
    if (tab) tab.focusedPaneId = paneId;
    state.focus = { spaceId, tabId: tab?.id ?? null, paneId };
  }

  private space(state: WorkbenchState, id: string) { return required(state.spaces.find(space => space.id === id), "스페이스를 찾을 수 없습니다."); }
  private tab(state: WorkbenchState, id: string) { return required(state.tabs.find(tab => tab.id === id), "탭을 찾을 수 없습니다."); }
  private pane(state: WorkbenchState, id: string) { return required(state.panes.find(pane => pane.id === id), "패널을 찾을 수 없습니다."); }

  openTerminal(paneId: string, restart?: string): Promise<WorkbenchTerminalBinding> {
    if (this.removing?.has(paneId)) return Promise.reject(conflict("이 패널을 닫고 있습니다."));
    const pending = this.opening.get(paneId);
    if (pending) return pending;
    const opening = this.bindTerminal(paneId, restart).finally(() => this.opening.delete(paneId));
    this.opening.set(paneId, opening);
    return opening;
  }

  private async bindTerminal(paneId: string, restart?: string): Promise<WorkbenchTerminalBinding> {
    if (!this.terminals) throw new CommandError("unavailable", "이 Host에서는 터미널을 열 수 없습니다.");
    const current = this.terminalIds.get(paneId);
    if (current) {
      if (current !== restart) return { id: current };
      await this.terminals.closeTerminal(current);
      this.terminalIds.delete(paneId);
    }
    // Recheck after the asynchronous close: a removed pane must never spawn a new PTY.
    if (this.removing?.has(paneId)) throw conflict("이 패널을 닫고 있습니다.");
    const pane = this.pane(this.read(), paneId);
    if (pane.kind !== "terminal") throw invalid("터미널 패널이 아닙니다.");
    const id = this.terminals.create({ ...pane.terminalSpec, cols: 80, rows: 24 });
    this.terminalIds.set(paneId, id);
    return { id };
  }
}
