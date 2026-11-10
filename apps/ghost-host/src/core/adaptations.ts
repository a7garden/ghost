import { ADAPTATION_MAX_CHARS, type Adaptation } from "@ghost/contract";
import type { Core } from "./core.ts";
import { conflict, invalid } from "./errors.ts";

/** Persisted per Ghost in `settings` (`adaptation:<ghostId>`): no ledger migration, older releases ignore it. */
const key = (ghostId: string) => `adaptation:${ghostId}`;

/**
 * What each Ghost learned about working in this owner's environment (owner decision 2026-11-10). A persona
 * written elsewhere meets a slightly different Mac, project layout or toolset here; instead of failing the
 * same way again, the Ghost records what works and starts from it next time. Behavior only: tools and PC
 * execution still change only through grants (capability_request, ghost_update, the owner).
 */
export class Adaptations {
  constructor(private readonly core: Core) {}

  get(ghostId: string): Adaptation | null {
    return this.core.ledger.setting<Adaptation | null>(key(ghostId), null);
  }

  /** Every Ghost with notes or history, for the snapshot. */
  view(): Adaptation[] {
    return this.core.ledger
      .ghosts()
      .filter((ghost) => ghost.deletedAt === null)
      .map((ghost) => this.get(ghost.id))
      .filter((adaptation): adaptation is Adaptation => adaptation !== null);
  }

  /**
   * Replace a Ghost's notes. Writing the same notes again is a no-op, so a replayed call changes nothing.
   * Live conversations other than `except` re-open so they start from the new notes; the caller already knows them.
   */
  set(ghostId: string, notes: string, by: Adaptation["by"], reason: string, except?: string): Adaptation {
    const ghost = this.core.ledger.ghost(ghostId);
    if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted`);
    const text = notes.trim();
    if (text.length > ADAPTATION_MAX_CHARS) throw invalid(`notes must be at most ${ADAPTATION_MAX_CHARS} characters; keep only what changes how you work here`);
    const current = this.get(ghostId);
    if (current && current.notes === text) return current;
    if (!current && text === "") throw invalid("there are no notes to clear");
    const next: Adaptation = {
      ghostId,
      notes: text,
      previous: current?.notes ?? null,
      by,
      reason: reason.trim().slice(0, 500),
      updatedAt: Date.now(),
      revision: (current?.revision ?? 0) + 1,
    };
    this.core.ledger.tx(() => {
      this.core.ledger.putSetting(key(ghostId), next);
      this.core.ledger.emit({ type: "adaptation", adaptation: next });
    });
    this.core.refreshGhost(ghostId, except);
    return next;
  }

  /** Instruction section for a Ghost's direct and work conversations; empty without notes. */
  instructions(ghostId: string): string {
    const notes = this.get(ghostId)?.notes;
    if (!notes) return "";
    return `## What you learned about this environment\nYour own notes from earlier work here (rewrite them with self_adapt). Where they differ from habits in your persona or skills, they win.\n\n${notes}`;
  }
}
