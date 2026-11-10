import { Type } from "typebox";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Work } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { CommandError, invalid } from "../core/errors.ts";
import { errorResult, requireAllowed, scopeOf } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

export const SOURCE_INSTRUCTIONS = `Sources: every web_read page gets an id like [S-0123456789]. Cite each fact with the id of the page it came from; when wording matters put the exact quote right before the id ("…" [S-…]). source_check verifies a quote against the page the Host stored; source_list shows what this conversation read. Never cite an id you did not get from web_read.`;

/**
 * Citation tools over the Host's source snapshots. Not owner-selectable on their own: they ride with
 * `web_read` in direct and Work conversations, and a reviewer always has them to check a result.
 */
export function createSourceTools(core: Core): Extension {
  /** The conversations whose reads this caller may list: its own, or for a reviewer the Work tree under review. */
  function scopeConversations(api: ToolExecutionApi): string[] {
    const scope = scopeOf(core, api);
    if (scope.conversation.kind !== "review") return [requireAllowed(core, api, "web_read").conversation.id];
    if (!scope.work) return [];
    const tree: Work[] = [];
    const walk = (work: Work) => { tree.push(work); for (const child of core.ledger.children(work.id)) walk(child); };
    walk(scope.work);
    return tree.map((work) => work.conversationId).filter((id): id is string => id !== null);
  }

  const sourceList = defineTool({
    name: "source_list",
    description: "List the pages read in this conversation (for a reviewer: in the Work under review) with their source ids, newest first.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        if (!core.sources) throw new CommandError("unavailable", "the source store is not available");
        const rows = core.sources.listFor(scopeConversations(api));
        if (rows.length === 0) return text("No sources recorded yet.");
        return text(rows.map((row) => `[${row.id}] ${row.title ?? "(untitled)"} — ${row.url} (${new Date(row.fetchedAt).toISOString()})`).join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const sourceCheck = defineTool({
    name: "source_check",
    description: "Check whether a quote appears in a recorded source (whitespace, width and case are ignored). Use before citing exact wording, and as a reviewer to verify citations.",
    parameters: Type.Object({
      source_id: Type.String({ pattern: "^S-[0-9a-f]{10}$", description: "A source id such as S-0123456789" }),
      quote: Type.String({ minLength: 4, maxLength: 2000, description: "The exact text claimed to be in the source" }),
    }),
    replay: "safe",
    async execute(args, api) {
      try {
        scopeConversations(api);
        if (!core.sources) throw new CommandError("unavailable", "the source store is not available");
        const result = core.sources.check(args.source_id, args.quote);
        if (!result.source) throw invalid(`${args.source_id} was never read; cite only ids web_read returned`);
        if (result.found) return text(`Found in [${result.source.id}] ${result.source.url}: …${result.context}…`);
        return text(`NOT found in [${result.source.id}] ${result.source.url}${result.truncated ? " (the stored snapshot was truncated, so a later passage cannot be checked)" : ""}. Re-read the page and quote it exactly, or drop the quote.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.sources", tools: [sourceList, sourceCheck] });
}
