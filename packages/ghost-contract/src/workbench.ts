import { Type, type Static } from "typebox";
import { Id, Timestamp, nullable } from "./entities.ts";

const title = Type.String({ minLength: 1, maxLength: 200 });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const body = { additionalProperties: false } as const;

export type Space = { id: string; title: string; root: string | null; createdAt: Static<typeof Timestamp> };
export type Layout =
  | { type: "pane"; paneId: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; first: Layout; second: Layout };
export type Tab = { id: string; spaceId: string; title: string; layout: Layout | null; focusedPaneId: string | null };

export const WorkbenchTerminalSpec = Type.Object({
  cwd: path,
  command: Type.Optional(path),
  args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 128 })),
}, body);
export type WorkbenchTerminalSpec = Static<typeof WorkbenchTerminalSpec>;
export type Pane =
  | { id: string; tabId: string; kind: "session"; sessionId: string }
  | { id: string; tabId: string; kind: "terminal"; terminalSpec: WorkbenchTerminalSpec };
export type WorkbenchState = {
  version: number;
  spaces: Space[];
  tabs: Tab[];
  panes: Pane[];
  focus: { spaceId: string; tabId: string | null; paneId: string | null } | null;
};

// A row puts the second pane to the right; a column puts it below.
export const WorkbenchDirection = Type.Union([Type.Literal("right"), Type.Literal("down")]);
export type WorkbenchDirection = Static<typeof WorkbenchDirection>;
export const WORKBENCH_MIN_RATIO = 0.1;
export const WORKBENCH_MAX_RATIO = 0.9;

export const WorkbenchVersion = Type.Object({ version }, body);
export const WorkbenchSpaceCreate = Type.Object({ version, title, root: nullable(path) }, body);
export type WorkbenchSpaceCreate = Static<typeof WorkbenchSpaceCreate>;
export const WorkbenchRename = Type.Object({ version, title }, body);
export type WorkbenchRename = Static<typeof WorkbenchRename>;
export const WorkbenchPaneCreate = Type.Object({
  version,
  targetPaneId: Type.Optional(Id),
  direction: Type.Optional(WorkbenchDirection),
  pane: Type.Union([
    Type.Object({ kind: Type.Literal("session"), sessionId: Id }, body),
    Type.Object({ kind: Type.Literal("terminal"), terminalSpec: Type.Optional(WorkbenchTerminalSpec) }, body),
  ]),
}, body);
export type WorkbenchPaneCreate = Static<typeof WorkbenchPaneCreate>;
export const WorkbenchResize = Type.Object({ version, ratio: Type.Number() }, body);
export type WorkbenchResize = Static<typeof WorkbenchResize>;
export const WorkbenchMove = Type.Object({ version, targetPaneId: Id }, body);
export type WorkbenchMove = Static<typeof WorkbenchMove>;
export const WorkbenchFocus = Type.Object({ version, spaceId: Id, tabId: Type.Optional(Id), paneId: Type.Optional(Id) }, body);
export type WorkbenchFocus = Static<typeof WorkbenchFocus>;
/** Live terminal bindings are never in WorkbenchState. An explicit restart names the old binding. */
export const WorkbenchTerminalOpen = Type.Object({ restart: Type.Optional(Id) }, body);
export type WorkbenchTerminalOpen = Static<typeof WorkbenchTerminalOpen>;
export type WorkbenchTerminalBinding = { id: string };
