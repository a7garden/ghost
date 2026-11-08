import type { Conversation, Ghost, GhostTool, Work } from "@ghost/contract";
import { HOST_TOOLS } from "@ghost/contract";
import type { Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { describeWork } from "../core/works.ts";
import { modelInputOf } from "../engine/models.ts";
import type { MemoryPort, DocumentsPort, SandboxEnvFactory, SkillsPort, ReachPort, HostPort } from "../integrations/ports.ts";
import { createDocumentsTools } from "./documents.ts";
import { createDirectTools } from "./direct.ts";
import { createInteractiveTools, INTERACTIVE_INSTRUCTIONS } from "./interactive.ts";
import { createMainTools } from "./main.ts";
import { createMemoryTools } from "./memory.ts";
import { createReviewTools } from "./review.ts";
import { createSkillsTools } from "./skills.ts";
import { createWebTools } from "./web.ts";
import type { ToolSet } from "./types.ts";
import { createWorkTools } from "./work.ts";
import { createHostTools } from "./host.ts";

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
delegate hands a self-contained part to another Ghost with done-criteria you write. When the result matters, pass reviewer_ghost_id naming a reviewer whose model vendor differs from the assignee's. After delegating, end your turn: do not poll or sleep. Its outcome arrives here as a message when it settles, with its files under inputs/<child id>/; complete refuses while a child is still live.
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
  host?: HostPort | null;
  skills: SkillsPort | null;
  /** Read-only web research (ghost.web); null leaves the tools out. */
  reach?: ReachPort | null;
}): ToolSet {
  const direct = createDirectTools(deps.core);
  const interactive = createInteractiveTools(deps.core);
  const work = createWorkTools(deps.core, deps.sandbox);
  const review = createReviewTools(deps.core);
  const main = createMainTools(deps.core);
  const memory = deps.memory === null ? null : createMemoryTools(deps.core, deps.memory);
  const documents = deps.documents === null ? null : createDocumentsTools(deps.core, deps.documents);
  const host = deps.host ? createHostTools(deps.core, deps.host) : null;
  const skills = deps.skills === null ? null : createSkillsTools(deps.core, deps.skills);
  const web = deps.reach ? createWebTools(deps.core, deps.reach) : null;

  return {
    all(): Extension[] {
      return [direct, interactive, work, review, main, ...(memory ? [memory] : []), ...(documents ? [documents] : []), ...(host ? [host] : []), ...(skills ? [skills] : []), ...(web ? [web] : [])];
    },
    extensionsFor(conversation: Conversation, ghost: Ghost, _work: Work | null): Extension[] {
      switch (conversation.kind) {
        case "direct": {
          const selected = [direct, interactive];
          if (deps.memory?.available(ghost.id) && memory) selected.push(memory);
          if ((deps.documents?.spacesFor(ghost.id).length ?? 0) > 0 && documents) selected.push(documents);
          if (host) selected.push(host);
          if (skills) selected.push(skills);
          if (web) selected.push(web);
          // Main-only management: resolved again at every execution, so a stale main keeps nothing.
          if (ghost.isDefault && ghost.state === "active") selected.push(main);
          return selected;
        }
        case "work": {
          const selected = [work];
          if (deps.memory?.available(ghost.id) && memory) selected.push(memory);
          if (host) selected.push(host);
          if (skills) selected.push(skills);
          if (web) selected.push(web);
          return selected;
        }
        case "review":
          return [review];
      }
    },
    instructionsFor(conversation: Conversation, ghost: Ghost, work: Work | null): string {
      switch (conversation.kind) {
        case "direct":
          return [DIRECT_INSTRUCTIONS, ghost.isDefault && ghost.state === "active" ? MAIN_INSTRUCTIONS : "", skillsInstructions(deps.skills, ghost)]
            .filter(Boolean)
            .join("\n\n");
        case "work":
          return [WORK_INSTRUCTIONS, delegationRoster(deps.core, ghost, { web: web !== null, host: host !== null }), work ? describeWork(work) : "", skillsInstructions(deps.skills, ghost)]
            .filter(Boolean)
            .join("\n\n");
        case "review":
          return [REVIEW_INSTRUCTIONS, work ? describeWork(work) : ""].filter(Boolean).join("\n\n");
      }
    },
  };
}

/** The exact preface every skills section opens with, above any skill body. */
const SKILLS_PREFACE =
  "Skills below were written for other agent harnesses. Use their guidance where your own tools can carry it out; never claim to have run a command or tool you do not have.";
/** One skill's body is cut here; the marker stays inside the budget. */
const MAX_SKILL_BODY_CHARS = 12_000;
/** The whole skills section, preface included, never exceeds this. */
const MAX_SKILLS_CHARS = 48_000;
const TRUNCATED = "\n\n[truncated]";

/**
 * The Ghost's skills in its own order, bodies included so the model can follow them without a
 * skill_read round trip. A skill missing from the owner's folders is named but marked unavailable
 * instead of being dropped, so editing a Ghost never silently reorders its context. Fully
 * deterministic: no timestamps, no catalog order — prompt caching holds while nothing changed.
 */
function skillsInstructions(skills: SkillsPort | null, ghost: Ghost): string {
  if (skills === null || ghost.skills.length === 0) return "";
  const sections: string[] = [SKILLS_PREFACE];
  let total = SKILLS_PREFACE.length;
  for (const name of ghost.skills) {
    // Whole-section granularity: when the cap is reached the remaining skills are omitted in order.
    const remaining = MAX_SKILLS_CHARS - total;
    if (remaining <= 2 + TRUNCATED.length) break;
    const body = skills.body(name);
    const header = body === null ? `## Skill: ${name} (unavailable)` : `## Skill: ${name}`;
    let section = body === null ? header : `${header}\n\n${boundedBody(body)}`;
    if (section.length + 2 > remaining) section = `${section.slice(0, remaining - 2 - TRUNCATED.length)}${TRUNCATED}`;
    sections.push(section);
    total += 2 + section.length;
  }
  return sections.join("\n\n");
}

/** Bodies are read from disk once per conversation setup; oversized ones keep a marked prefix. */
function boundedBody(body: string): string {
  return body.length <= MAX_SKILL_BODY_CHARS ? body : `${body.slice(0, MAX_SKILL_BODY_CHARS - TRUNCATED.length)}${TRUNCATED}`;
}

/** Tools that reach outside the host: the roster's `web` tag. */
const WEB_TOOLS: readonly GhostTool[] = ["web_search", "web_read", "reach"];

/**
 * The peers a Work can delegate to, each with what it can do: its resolved model (`provider/model`,
 * its own or the default) and whether that model takes images, plus `web` and `host` tags. Work
 * conversations have no ghost_list, so without this roster the model has no valid ghost_id for
 * delegate. Read when the conversation is configured — at Work start, and again whenever any Ghost
 * changes (core.refreshRosters).
 */
function delegationRoster(core: Core, ghost: Ghost, installed: { web: boolean; host: boolean }): string {
  if (!ghost.tools.includes("delegate")) return "";
  const settings = core.ledger.settings();
  const peers = core.ledger.ghosts().filter((peer) => peer.state === "active" && peer.deletedAt === null && peer.id !== ghost.id);
  if (peers.length === 0) return "";
  const rows = peers.map((peer) => {
    const model = peer.model ?? settings.defaultModel;
    const provider = model ? settings.providers.find((item) => item.id === model.provider) : undefined;
    const acceptsImages =
      model && provider ? modelInputOf(provider, model.model, core.secrets.credential(provider.id)).includes("image") : false;
    const tags = [
      model ? `${model.provider}/${model.model}` : "",
      acceptsImages ? "image" : "",
      installed.web && WEB_TOOLS.some((tool) => peer.tools.includes(tool)) ? "web" : "",
      installed.host && HOST_TOOLS.some((tool) => peer.tools.includes(tool)) ? "host" : "",
    ].filter(Boolean);
    const persona = peer.persona.trim();
    return [`- ${peer.name} (ghost_id ${peer.id})`, persona && `— ${persona.split("\n")[0]}`, tags.length > 0 && `[${tags.join(" ")}]`]
      .filter(Boolean)
      .join(" ");
  });
  return `Ghosts you can delegate to:\n${rows.join("\n")}`;
}
