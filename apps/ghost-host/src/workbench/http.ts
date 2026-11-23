import {
  Id, parse, WorkbenchFocus, WorkbenchMove, WorkbenchPaneCreate, WorkbenchRename, WorkbenchResize,
  WorkbenchSpaceCreate, WorkbenchTerminalOpen, WorkbenchVersion, type Principal,
} from "@ghost/contract";
import { forbidden, invalid, notFound } from "../core/errors.ts";
import type { Workbench } from "./service.ts";

/** The API is intentionally not a Ghost tool: a PTY runs with the owner's Mac access, outside coding's tool grants. */
export async function serveWorkbench(bench: Workbench, principal: Principal | { kind: "ghost" }, request: Request, pathname: string) {
  if (principal.kind !== "owner" && principal.kind !== "device") throw forbidden("작업대는 소유자만 조작할 수 있습니다.");
  const method = request.method;
  const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("요청 본문이 올바르지 않습니다."); });
  if (pathname === "/api/workbench/spaces") {
    if (method === "GET") return bench.read();
    if (method === "POST") return bench.createSpace(parse(WorkbenchSpaceCreate, await body()));
  }
  if (pathname === "/api/workbench/focus" && method === "POST") return bench.focus(parse(WorkbenchFocus, await body()));
  const terminalFocus = /^\/api\/workbench\/terminals\/([^/]+)\/focus$/.exec(pathname);
  if (terminalFocus && method === "POST") {
    const { version } = parse(WorkbenchVersion, await body());
    return bench.focusTerminal(parse(Id, decodeId(terminalFocus[1]!)), version);
  }

  const route = /^\/api\/workbench\/(spaces|tabs|panes)\/([^/]+)(?:\/(tabs|panes|splits|move|terminal)(?:\/([^/]+))?)?$/.exec(pathname);
  if (!route) throw notFound("작업대 경로를 찾을 수 없습니다.");
  const [, resource, rawId, action, extra] = route;
  const id = parse(Id, decodeId(rawId!));
  if (!action && method === "DELETE") {
    const { version } = parse(WorkbenchVersion, await body());
    if (resource === "spaces") return bench.deleteSpace(id, version);
    if (resource === "tabs") return bench.deleteTab(id, version);
    return bench.deletePane(id, version);
  }
  if (!action && method === "PATCH" && resource !== "panes") {
    const { version, title } = parse(WorkbenchRename, await body());
    return resource === "spaces" ? bench.renameSpace(id, version, title) : bench.renameTab(id, version, title);
  }
  if (!extra && method === "POST") {
    if (resource === "spaces" && action === "tabs") {
      const { version, title } = parse(WorkbenchRename, await body());
      return bench.createTab(id, version, title);
    }
    if (resource === "tabs" && action === "panes") return bench.addPane(id, parse(WorkbenchPaneCreate, await body()));
    if (resource === "panes" && action === "move") {
      const { version, targetPaneId } = parse(WorkbenchMove, await body());
      return bench.move(id, targetPaneId, version);
    }
    if (resource === "panes" && action === "terminal") {
      const { restart } = parse(WorkbenchTerminalOpen, await body());
      return bench.openTerminal(id, restart);
    }
  }
  if (resource === "tabs" && action === "splits" && extra && method === "PATCH") {
    const { version, ratio } = parse(WorkbenchResize, await body());
    return bench.resize(id, parse(Id, decodeId(extra)), version, ratio);
  }
  throw notFound("작업대 경로를 찾을 수 없습니다.");
}

function decodeId(value: string): string {
  try { return decodeURIComponent(value); } catch { throw invalid("작업대 ID가 올바르지 않습니다."); }
}
