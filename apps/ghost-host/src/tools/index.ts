import type { Conversation, Ghost, Work } from "@ghost/contract";
import type { Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { describeWork } from "../core/works.ts";
import type { MemoryPort, DocumentsPort, SandboxEnvFactory } from "../integrations/ports.ts";
import { createDocumentsTools } from "./documents.ts";
import { createDirectTools } from "./direct.ts";
import { createMemoryTools } from "./memory.ts";
import { createReviewTools } from "./review.ts";
import type { ToolSet } from "./types.ts";
import { createWorkTools } from "./work.ts";

const DIRECT_INSTRUCTIONS = `This is a direct conversation with the owner: talk with them and act in conversation.
Create a Work (work_create) only when the owner explicitly hands over a task — never for ideas, questions or chat. A Work runs in its own conversation and reports back here.
work_list and work_inspect show progress; work_update edits a live Work; work_cancel stops one.
ask_owner asks the owner a question when a decision is theirs; the answer arrives as a message.
schedule_create wakes this conversation once at a given time or on an interval; schedule_list and schedule_cancel manage schedules.
ghost_list shows the active Ghosts; hand a task to a better-fit Ghost with work_create and its ghost_id.`;

const WORK_INSTRUCTIONS = `This conversation executes exactly one Work. Stay on it.
read, write, edit and bash operate in the Work's sandbox workspace; publish everything the result needs with publish_artifact before completing.
complete claims the result with a truthful summary naming only published artifacts; verification — checks, a reviewer or the owner — decides acceptance, not you.
delegate hands a self-contained part to another Ghost with done-criteria you write. After delegating, end your turn: do not poll or sleep. Its outcome arrives here as a message when it settles, with its files under inputs/<child id>/; complete refuses while a child is still live.
work_status shows this Work's state and children; ask_owner when only the owner can decide something.`;

const REVIEW_INSTRUCTIONS = `This conversation reviews one Work. Judge only from its artifacts (artifact_read) and recorded effects (effect_list) — never from the assignee's claims.
Call verdict exactly once: pass, revise, or fail with concrete reasons. revise sends your reasons back to the assignee for another attempt.`;

/** The model-facing capability of each conversation kind (src/tools/types.ts). */
export function createToolSet(deps: {
  core: Core;
  sandbox: SandboxEnvFactory;
  memory: MemoryPort | null;
  documents: DocumentsPort | null;
}): ToolSet {
  const direct = createDirectTools(deps.core);
  const work = createWorkTools(deps.core, deps.sandbox);
  const review = createReviewTools(deps.core);
  const memory = deps.memory === null ? null : createMemoryTools(deps.core, deps.memory);
  const documents = deps.documents === null ? null : createDocumentsTools(deps.core, deps.documents);

  return {
    all(): Extension[] {
      return [direct, work, review, ...(memory ? [memory] : []), ...(documents ? [documents] : [])];
    },
    extensionsFor(conversation: Conversation, ghost: Ghost, _work: Work | null): Extension[] {
      switch (conversation.kind) {
        case "direct": {
          const selected = [direct];
          if (deps.memory?.available(ghost.id) && memory) selected.push(memory);
          if ((deps.documents?.spacesFor(ghost.id).length ?? 0) > 0 && documents) selected.push(documents);
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
          return DIRECT_INSTRUCTIONS;
        case "work":
          return [WORK_INSTRUCTIONS, work ? describeWork(work) : ""].filter(Boolean).join("\n\n");
        case "review":
          return [REVIEW_INSTRUCTIONS, work ? describeWork(work) : ""].filter(Boolean).join("\n\n");
      }
    },
  };
}
