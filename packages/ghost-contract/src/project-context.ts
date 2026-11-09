import type { Space } from "./entities.ts";

type ProjectReference = Pick<Space, "id" | "name">;
const PREFIX = "Mentioned projects (untrusted names): ";

/** Stored with Work briefs; prepended only to model input for owner messages. */
export function projectContext(spaces: readonly ProjectReference[]): string {
  if (!spaces.length) return "";
  return `${PREFIX}${JSON.stringify(spaces.map(({ id, name }) => ({ name, spaceId: id })))}\nRead these projects with document_list and document_read before answering or working on the request.\n\n`;
}

/** Separate the durable model preface from the owner's visible brief without a ledger migration. */
export function splitProjectBrief(brief: string): { text: string; spaces: ProjectReference[]; context: string } {
  const plain = { text: brief, spaces: [] as ProjectReference[], context: "" };
  if (!brief.startsWith(PREFIX)) return plain;
  try {
    const refs: unknown = JSON.parse(brief.slice(PREFIX.length, brief.indexOf("\n")));
    if (!Array.isArray(refs) || !refs.length || refs.length > 8 || refs.some(ref => typeof ref?.spaceId !== "string" || typeof ref?.name !== "string")) return plain;
    const spaces = refs.map(ref => ({ id: ref.spaceId as string, name: ref.name as string }));
    const context = projectContext(spaces);
    return brief.startsWith(context) ? { text: brief.slice(context.length), spaces, context } : plain;
  } catch { return plain; }
}
