import { Type, type Static } from "typebox";
import { Id, Timestamp, nullable } from "./entities.ts";

const title = Type.String({ minLength: 1, maxLength: 200 });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const body = { additionalProperties: false } as const;

export type Space = {
  id: string;
  title: string;
  root: string | null;
  createdAt: Static<typeof Timestamp>;
  worktree?: { repo: string; branch: string };
  /** The agent shown when the owner returns to this space. */
  lastSessionId?: string;
};
/** A built-in coding session listed in one space. The session outlives the entry: removing an agent never closes it. */
export type Agent = { sessionId: string; spaceId: string };
export type WorkbenchState = {
  version: number;
  spaces: Space[];
  agents: Agent[];
  focus: { spaceId: string; sessionId: string | null } | null;
};

export const WorkbenchVersion = Type.Object({ version }, body);
export const WorkbenchSpaceCreate = Type.Object({
  version, title, root: nullable(path),
  worktree: Type.Optional(Type.Object({ branch: Type.String({ minLength: 1, maxLength: 200 }) }, body)),
}, body);
export type WorkbenchSpaceCreate = Static<typeof WorkbenchSpaceCreate>;
export const WorkbenchRename = Type.Object({ version, title }, body);
export type WorkbenchRename = Static<typeof WorkbenchRename>;
export const WorkbenchAgentCreate = Type.Object({ version, sessionId: Id }, body);
export type WorkbenchAgentCreate = Static<typeof WorkbenchAgentCreate>;
export const WorkbenchFocus = Type.Object({ version, spaceId: Id, sessionId: Type.Optional(Id) }, body);
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

export type WorkbenchFileDiff = { path: string; staged: string; unstaged: string; truncated: boolean };
