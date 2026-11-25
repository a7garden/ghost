import { Type, type Static } from "typebox";
import { Id, nullable } from "./entities.ts";

const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const body = { additionalProperties: false } as const;

/**
 * A built-in coding session listed in the workbench under a project (Scope), or under 프로젝트 없음 when `scopeId` is null.
 * The session outlives the entry: removing an agent never closes it. A session a Ghost started is not listed here; the UI
 * finds its project through its Work (`CodingSession.workId` → `Work.scopeId`).
 */
export type Agent = { sessionId: string; scopeId: string | null };
export type WorkbenchState = {
  version: number;
  agents: Agent[];
  /** The project on screen (null: 프로젝트 없음) and its focused agent. */
  focus: { scopeId: string | null; sessionId: string | null } | null;
};

export const WorkbenchVersion = Type.Object({ version }, body);
export const WorkbenchAgentCreate = Type.Object({ version, sessionId: Id, scopeId: nullable(Id) }, body);
export type WorkbenchAgentCreate = Static<typeof WorkbenchAgentCreate>;
/** Moves an agent to another project, or to 프로젝트 없음. */
export const WorkbenchAgentMove = Type.Object({ version, scopeId: nullable(Id) }, body);
export type WorkbenchAgentMove = Static<typeof WorkbenchAgentMove>;
export const WorkbenchFocus = Type.Object({ version, scopeId: nullable(Id), sessionId: Type.Optional(Id) }, body);
export type WorkbenchFocus = Static<typeof WorkbenchFocus>;

export type WorkbenchChanges = {
  branch: string | null;
  files: {
    path: string;
    status: "added" | "modified" | "deleted" | "untracked";
    /** Git porcelain XY flags (index and working tree). */
    xy: string;
    additions: number | null;
    deletions: number | null;
  }[];
  truncated: boolean;
};

/** `GET /api/workbench/changes?root=<abs>` lists Git changes of a project folder or an agent's cwd; adding `&path=` returns one file's diff. */
export type WorkbenchFileDiff = { path: string; staged: string; unstaged: string; truncated: boolean };
