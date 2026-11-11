import { useSyncExternalStore } from 'react';
import { reviewOf, type Decision, type State } from '@ghost/contract';
import { highRiskApproval } from './Decision';
import { secureFormProposal, browserHandoffProposal } from './decisionText';
import { handedOver } from './ghostState';

export { handedOver };

/**
 * 확인할 일을 빨리 비우는 데 쓰는 규칙 (2026.11.11).
 * 「답할 차례」 · 「메인에게 맡김」 · 「나중에」 · 「추천대로」가 무엇인지를 여기 한 곳에서 정한다 —
 * 사이드바 배지 · 홈 · 펫 · 확인할 일 목록이 서로 다른 수를 세지 않게.
 */

/**
 * 메인에게 맡길 수 있는가. Host 의 `Decisions.delegate` 와 같은 조건을 화면에서 미리 본다 —
 * Host 가 붙인 추천은 되돌릴 수 있는 결정에만 있으므로 그것으로 가린다. 판단은 결국 Host 가 다시 한다.
 */
export function canHandOver(decision: Decision, state: State): boolean {
  if (decision.state !== 'pending' || handedOver(decision) || !reviewOf(decision.proposal)?.recommend) return false;
  const main = state.ghosts.find(ghost => ghost.isDefault && ghost.deletedAt === null);
  if (!main || main.state !== 'active' || main.id === decision.ghostId) return false;
  return (state.settings.approvals?.delegate ?? 'reversible') === 'reversible';
}

/** 추천대로 처리할 때 보낼 결과. 추천이 없거나 위험해서 한 장씩 봐야 하는 결정은 null. */
export function recommendedResolution(decision: Decision): { outcome: 'approve' } | { outcome: 'answer'; answer: string } | null {
  if (decision.state !== 'pending' || handedOver(decision)) return null;
  if (secureFormProposal(decision) || browserHandoffProposal(decision) || highRiskApproval(decision)) return null;
  const review = reviewOf(decision.proposal);
  if (review?.recommend === 'approve') return { outcome: 'approve' };
  if (review?.recommend === 'answer' && review.answer && (decision.options.length === 0 || decision.options.includes(review.answer))) return { outcome: 'answer', answer: review.answer };
  return null;
}

/** 추천대로 처리하면 무엇을 하는지, 버튼 옆에 짧게. */
export function recommendedLabel(decision: Decision): string | null {
  const resolution = recommendedResolution(decision);
  if (!resolution) return null;
  return resolution.outcome === 'answer' ? `「${resolution.answer}」` : decision.kind === 'document_review' ? '저장 승인' : '승인';
}

// ── 나중에 ──────────────────────────────────────────────────────────────
// 이 기기에서만 뒤로 미룬다. 결정 자체는 그대로 기다리고, 자동 처리 시각도 바뀌지 않는다.
// Host 에 두지 않은 까닭: 「지금 이 화면에서 넘기기」일 뿐이라 다른 기기의 순서까지 바꿀 일이 아니다.

const LATER_KEY = 'ghost.decisions.later';
type Later = Record<string, number>;
const listeners = new Set<() => void>();
let later: Later = load();

function load(): Later {
  try {
    const saved = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(LATER_KEY) ?? 'null') as unknown;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([, at]) => typeof at === 'number')) as Later : {};
  } catch { return {}; }
}

function save(next: Later) {
  later = next;
  try { localStorage.setItem(LATER_KEY, JSON.stringify(next)); } catch { /* 사설 모드 등에서 못 저장해도 이번 화면에서는 미뤄진다 */ }
  for (const listener of listeners) listener();
}

export function deferDecision(id: string) { save({ ...later, [id]: Date.now() }); }
export function undeferDecision(id: string) { const { [id]: _gone, ...rest } = later; save(rest); }

/** 끝난 결정의 표시는 버린다 — 저장소가 쌓이지 않게. */
export function pruneLater(pendingIds: Iterable<string>) {
  const keep = new Set(pendingIds);
  if (Object.keys(later).some(id => !keep.has(id))) save(Object.fromEntries(Object.entries(later).filter(([id]) => keep.has(id))));
}

export function useLater(): Later {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => later, () => later);
}

/** 주인이 볼 순서: 오래 기다린 것부터, 미룬 것은 미룬 순서대로 맨 뒤. */
export function ownerOrder(decisions: Decision[], deferred: Later): Decision[] {
  const now = decisions.filter(decision => deferred[decision.id] === undefined).sort((a, b) => a.createdAt - b.createdAt);
  const after = decisions.filter(decision => deferred[decision.id] !== undefined).sort((a, b) => deferred[a.id]! - deferred[b.id]!);
  return [...now, ...after];
}
