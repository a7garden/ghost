import { Id, parse, WorkbenchAgentCreate, WorkbenchAgentMove, WorkbenchFocus, WorkbenchVersion, type Principal } from "@ghost/contract";
import { forbidden, invalid, notFound } from "../core/errors.ts";
import type { Workbench } from "./service.ts";

/** The workbench is the owner's: it lists and arranges sessions that run with the owner's Mac access, outside coding's tool grants. */
export async function serveWorkbench(bench: Workbench, principal: Principal | { kind: "ghost" }, request: Request, pathname: string) {
  if (principal.kind !== "owner" && principal.kind !== "device") throw forbidden("작업대는 소유자만 조작할 수 있습니다.");
  const method = request.method;
  const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("요청 본문이 올바르지 않습니다."); });
  if (pathname === "/api/workbench" && method === "GET") return bench.read();
  if (pathname === "/api/workbench/agents" && method === "POST") return bench.addAgent(parse(WorkbenchAgentCreate, await body()));
  if (pathname === "/api/workbench/focus" && method === "POST") return bench.focus(parse(WorkbenchFocus, await body()));
  if (pathname === "/api/workbench/changes" && method === "GET") {
    const params = new URL(request.url).searchParams;
    const root = params.get("root");
    if (root === null) throw invalid("조회할 폴더를 지정하세요.");
    return bench.changes(root, params.get("path"));
  }
  if (pathname === "/api/workbench/folders" && method === "GET") {
    const scopeId = new URL(request.url).searchParams.get("scopeId");
    if (!scopeId) throw invalid("프로젝트를 지정하세요.");
    return bench.folders(parse(Id, scopeId));
  }
  const route = /^\/api\/workbench\/agents\/([^/]+)$/.exec(pathname);
  if (route) {
    const sessionId = parse(Id, decodeId(route[1]!));
    if (method === "DELETE") return bench.removeAgent(sessionId, parse(WorkbenchVersion, await body()).version);
    if (method === "PATCH") return bench.moveAgent(sessionId, parse(WorkbenchAgentMove, await body()));
  }
  throw notFound("작업대 경로를 찾을 수 없습니다.");
}

function decodeId(value: string): string {
  try { return decodeURIComponent(value); } catch { throw invalid("작업대 ID가 올바르지 않습니다."); }
}
