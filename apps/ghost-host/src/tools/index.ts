import type { Conversation, Ghost, Work } from "@ghost/contract";
import type { Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { describeWork } from "../core/works.ts";
import type { MemoryPort, DocumentsPort, SandboxEnvFactory } from "../integrations/ports.ts";
import { createDocumentsTools } from "./documents.ts";
import { createDirectTools } from "./direct.ts";
import { createInteractiveTools, INTERACTIVE_INSTRUCTIONS } from "./interactive.ts";
import { createMainTools } from "./main.ts";
import { createMemoryTools } from "./memory.ts";
import { createReviewTools } from "./review.ts";
import type { ToolSet } from "./types.ts";
import { createWorkTools } from "./work.ts";

/**
 * How a Ghost speaks to the owner. Briefs between Ghosts stay exact; what a person reads is a
 * conversation. The app already renders each Work's card, state, files and technical details.
 */
const OWNER_VOICE = `Talk to the owner the way a capable colleague would, in their language. They read a polished app, not a log: it already shows each Work as a card with its state and files, and keeps the technical details one hover away.
- Lead with what happened or what you think, in a sentence or two; add only what they need to understand, decide or do next.
- Never write ids, digests, hashes, byte counts, exit codes, tool or command names, sandbox paths or verification mechanics unless the owner asks. Name a Work by its title and a file by its name.
- When a Work reports back, do not restate the report the app already shows. Say what came of it in plain words, and raise only what needs the owner — a choice, a risk, a failure and what you will do about it.
- Prefer short paragraphs to headings and bullet lists; use structure only when it genuinely helps them scan.
Keep the exactness for Ghost-to-Ghost briefs (work_create, delegate): done-criteria, paths and checks belong there, not in what the owner reads.`;

const DIRECT_INSTRUCTIONS = `This is a direct conversation with the owner: talk with them and act in conversation.
Create a Work (work_create) only when the owner explicitly hands over a task — never for ideas, questions or chat. A Work runs in its own conversation and reports back here.
work_list and work_inspect show progress; work_update edits a live Work; work_cancel stops one.
ask_owner asks the owner a question when a decision is theirs; the answer arrives as a message.
schedule_create wakes this conversation once at a given time or on an interval; schedule_list and schedule_cancel manage schedules.
ghost_list shows the active Ghosts; hand a task to a better-fit Ghost with work_create and its ghost_id.

${OWNER_VOICE}

${INTERACTIVE_INSTRUCTIONS}`;

const WORK_INSTRUCTIONS = `This conversation executes exactly one Work. Stay on it.
read, write, edit and bash operate in the Work's sandbox workspace; publish everything the result needs with publish_artifact before completing.
complete claims the result with a truthful summary naming only published artifacts; verification — checks, a reviewer or the owner — decides acceptance, not you. The owner reads that summary too: open it with one plain sentence saying what was made, then the evidence a reviewer needs.
delegate hands a self-contained part to another Ghost with done-criteria you write. After delegating, end your turn: do not poll or sleep. Its outcome arrives here as a message when it settles, with its files under inputs/<child id>/; complete refuses while a child is still live.
work_status shows this Work's state and children; ask_owner when only the owner can decide something, phrased for a person: plain words and the choice itself, without ids, paths or tool names.`;

const REVIEW_INSTRUCTIONS = `This conversation reviews one Work. Judge only from its artifacts (artifact_read) and recorded effects (effect_list) — never from the assignee's claims.
Call verdict exactly once: pass, revise, or fail with concrete reasons. revise sends your reasons back to the assignee for another attempt.`;

const MAIN_INSTRUCTIONS = `As the current main Ghost you can ghost_inspect another Ghost's configuration and ghost_update its name, persona, model, look, state or tool allow-list. The main designation and your own settings belong to the owner.`;

/** The model-facing capability of each conversation kind (src/tools/types.ts). */
export function createToolSet(deps: {
  core: Core;
  sandbox: SandboxEnvFactory;
  memory: MemoryPort | null;
  documents: DocumentsPort | null;
}): ToolSet {
  const direct = createDirectTools(deps.core);
  const interactive = createInteractiveTools(deps.core);
  const work = createWorkTools(deps.core, deps.sandbox);
  const review = createReviewTools(deps.core);
  const main = createMainTools(deps.core);
  const memory = deps.memory === null ? null : createMemoryTools(deps.core, deps.memory);
  const documents = deps.documents === null ? null : createDocumentsTools(deps.core, deps.documents);

  return {
    all(): Extension[] {
      return [direct, interactive, work, review, main, ...(memory ? [memory] : []), ...(documents ? [documents] : [])];
    },
    extensionsFor(conversation: Conversation, ghost: Ghost, _work: Work | null): Extension[] {
      switch (conversation.kind) {
        case "direct": {
          const selected = [direct, interactive];
          if (deps.memory?.available(ghost.id) && memory) selected.push(memory);
          if ((deps.documents?.spacesFor(ghost.id).length ?? 0) > 0 && documents) selected.push(documents);
          // Main-only management: resolved again at every execution, so a stale main keeps nothing.
          if (ghost.isDefault && ghost.state === "active") selected.push(main);
          return selected;
        }
        case "work": {
          const selected = [work];
          if (deps.memory?.available(ghost.id) && memory) selected.push(memory);
          return selected;
        }
        case "review":
          return [review];
      }
    },
    instructionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): string {
      switch (conversation.kind) {
        case "direct":
          return ghost.isDefault && ghost.state === "active" ? `${DIRECT_INSTRUCTIONS}\n\n${MAIN_INSTRUCTIONS}` : DIRECT_INSTRUCTIONS;
        case "work":
          return [WORK_INSTRUCTIONS, delegationRoster(deps.core, ghost), work ? describeWork(work) : ""].filter(Boolean).join("\n\n");
        case "review":
          return [REVIEW_INSTRUCTIONS, work ? describeWork(work) : ""].filter(Boolean).join("\n\n");
      }
    },
  };
}

/**
 * The peers a Work can delegate to. Work conversations have no ghost_list, so without this roster the
 * model has no valid ghost_id for delegate. Read when the conversation is configured (Work start).
 */
function delegationRoster(core: Core, ghost: Ghost): string {
  if (!ghost.tools.includes("delegate")) return "";
  const peers = core.ledger.ghosts().filter((peer) => peer.state === "active" && peer.id !== ghost.id);
  if (peers.length === 0) return "";
  const rows = peers.map((peer) => `- ${peer.name} (ghost_id ${peer.id})${peer.persona.trim() ? ` — ${peer.persona.trim().split("\n")[0]}` : ""}`);
  return `Ghosts you can delegate to:\n${rows.join("\n")}`;
}
