/**
 * What the Host attaches to a pending decision so nobody waits on it blindly (2026-11-10 owner decision):
 * the recommendation, when it goes ahead without the owner, and — once settled — who settled it.
 * Lives under `proposal.review` of reversible decisions only; sending, spending, card entry and deletion never carry it.
 */
export type DecisionReview = {
  /** `approve` for an approval, `answer` (with `answer`) for a question. */
  recommend: "approve" | "answer";
  answer?: string;
  /** When the Host takes the recommendation if the owner has not answered; null when the policy turns it off. */
  expiresAt: number | null;
  /** The main Ghost's view of it, in the owner's language, when it left the decision to the owner. */
  mainNote?: string;
  /** Set when someone other than the owner settled it. */
  resolvedBy?: "main" | "timeout";
};

/** Words of loss in a stated risk; such a command is never reversible and asks for a second press. */
export const DESTRUCTIVE_RISK = /삭제|영구|되돌릴 수 없|복구할 수 없|덮어|초기화|유실|손실|delete|overwrite|irreversib|wipe|destroy/i;

/** The review a decision carries, or null. */
export function reviewOf(proposal: Record<string, unknown> | null | undefined): DecisionReview | null {
  const review = proposal?.review;
  return review !== null && typeof review === "object" && ((review as DecisionReview).recommend === "approve" || (review as DecisionReview).recommend === "answer")
    ? review as DecisionReview : null;
}
