import type { BrowserHandoff, Decision, DecisionKind, GoalProposal, SecureFormRequest, State, VaultContact, VaultItemKind } from '@ghost/contract';

export const decisionLabel: Record<DecisionKind, string> = {
  approve_effect: '실행 승인', question: '답변 대기', accept_result: '결과 확인',
  document_review: '문서 검토', reconcile_effect: '결과 미확정',
};

/** A result to accept is named by its Work; every other decision by its own title. */
export function decisionHeading(decision: Decision, state: State): string {
  const work = decision.kind === 'accept_result' && decision.workId ? state.works.find(item => item.id === decision.workId) : undefined;
  return work?.title ?? decision.title;
}

/** Chip text for the two question shapes that need more than a typed answer. */
export const secureFormLabel = '금고 요청';
export const browserHandoffLabel = '브라우저 대기';
export const goalProposalLabel = '목표 제안';

/** An owner-only goal proposal uses the ordinary question options. */
export function goalProposal(decision: Decision): GoalProposal | null {
  const goal = decision.kind === 'question' ? decision.proposal?.goal : undefined;
  return goal !== null && typeof goal === 'object' && typeof (goal as GoalProposal).title === 'string' ? goal as GoalProposal : null;
}

/** The chip of one decision: a question reads its proposal shape, every other kind its own label. */
export function decisionChip(decision: Decision): string {
  if (decision.kind !== 'question') return decisionLabel[decision.kind];
  return goalProposal(decision) ? goalProposalLabel : secureFormProposal(decision) ? secureFormLabel : browserHandoffProposal(decision) ? browserHandoffLabel : decisionLabel.question;
}

/** The completion answer a browser handoff suggests; it goes through the ordinary answer path. */
export const handoffDoneAnswer = '다 했어요';

const vaultKinds: readonly VaultItemKind[] = ['login', 'card', 'contact', 'secret'];

/** `proposal.secureForm` of a `question`: the owner answers through the vault, never in chat. Null otherwise. */
export function secureFormProposal(decision: Decision): SecureFormRequest | null {
  const request = decision.kind === 'question' ? decision.proposal?.secureForm : undefined;
  return request !== null && typeof request === 'object' && vaultKinds.includes((request as SecureFormRequest).kind)
    ? request as SecureFormRequest : null;
}

/** `proposal.browserHandoff` of a `question`: a visible Chrome window on this Mac waits for the owner. Null otherwise. */
export function browserHandoffProposal(decision: Decision): BrowserHandoff | null {
  const handoff = decision.kind === 'question' ? decision.proposal?.browserHandoff : undefined;
  return handoff !== null && typeof handoff === 'object' ? handoff as BrowserHandoff : null;
}

/** Every field a secure form collects; a kind reads only its own. */
export type SecureFormValues = {
  origin: string;
  username: string; password: string; totp: string;
  cardNumber: string; cardExpiry: string; cardCvc: string; cardName: string;
  contactName: string; contactPhone: string; contactEmail: string; contactAddress: string;
  value: string;
};

export const emptySecureForm: SecureFormValues = {
  origin: '',
  username: '', password: '', totp: '',
  cardNumber: '', cardExpiry: '', cardCvc: '', cardName: '',
  contactName: '', contactPhone: '', contactEmail: '', contactAddress: '',
  value: '',
};

const trim = (value: string) => value.trim();

/**
 * The exact body a secure-form submit posts to `/api/vault/requests/:decisionId`:
 * `kind` (the host rejects a mismatch), the item fields of that kind, and `save`.
 * Passwords and secret values stay verbatim (spaces can be part of a secret);
 * every other field is trimmed. A login without a requested origin carries the
 * typed `origin`. Pure; tests pin it.
 */
export function secureFormBody(request: SecureFormRequest, values: SecureFormValues, save: boolean):
  { body: Record<string, unknown> } | { error: string } {
  if (request.kind === 'login') {
    const username = trim(values.username);
    if (!username) return { error: '사용자 이름을 입력해 주세요.' };
    if (!values.password) return { error: '비밀번호를 입력해 주세요.' };
    const totp = trim(values.totp);
    const origin: Record<string, unknown> = request.origin ? {} : { origin: trim(values.origin) };
    if (!request.origin && !origin.origin) return { error: 'https://로 시작하는 주소를 입력해 주세요.' };
    return { body: { kind: request.kind, username, password: values.password, ...(totp ? { totp } : {}), ...origin, save } };
  }
  if (request.kind === 'card') {
    const number = trim(values.cardNumber), expiry = trim(values.cardExpiry), cvc = trim(values.cardCvc), name = trim(values.cardName);
    if (!number || !expiry || !cvc || !name) return { error: '카드 번호와 유효기간, CVC, 이름을 입력해 주세요.' };
    return { body: { kind: request.kind, card: { number, expiry, cvc, name }, save } };
  }
  if (request.kind === 'contact') {
    const contact: VaultContact = {
      ...(trim(values.contactName) ? { name: trim(values.contactName) } : {}),
      ...(trim(values.contactPhone) ? { phone: trim(values.contactPhone) } : {}),
      ...(trim(values.contactEmail) ? { email: trim(values.contactEmail) } : {}),
      ...(trim(values.contactAddress) ? { address: trim(values.contactAddress) } : {}),
    };
    if (!Object.keys(contact).length) return { error: '한 항목 이상 입력해 주세요.' };
    return { body: { kind: request.kind, contact, save } };
  }
  if (!values.value) return { error: '값을 입력해 주세요.' };
  return { body: { kind: request.kind, value: values.value, save } };
}
