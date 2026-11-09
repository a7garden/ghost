import { randomUUID } from 'node:crypto';

/**
 * Deterministic data seeding through the owner API only. Every turn runs against
 * the mock provider, so `message.send` resolves after the whole model turn has
 * settled and the seed is a straight sequence of API calls.
 */

export interface SeedResult {
  defaultGhostId: string;
  researchGhostId: string;
  scribeGhostId: string;
  conversationA: string;
  conversationB: string;
  workDoneId: string;
  workLiveId: string;
  questionDecisionId: string;
  spaceId: string;
}

export interface HostHandle { baseUrl: string; token: string; mockBaseUrl: string; /** Existing absolute folder the seeded project space points at. */ spacePath: string; }

interface GhostRow { id: string; name: string; isDefault: boolean; directConversationId: string; }
interface WorkRow { id: string; state: string; }
interface DecisionRow { id: string; kind: string; state: string; workId: string | null; }
interface StateRows {
  ghosts: GhostRow[];
  works: WorkRow[];
  decisions: DecisionRow[];
  conversations: { id: string; busy: boolean }[];
}
interface WorkDetailResponse { work: WorkRow; decisions: DecisionRow[]; }

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

async function command(host: HostHandle, command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${host.baseUrl}/api/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), command }),
  });
  const body = await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } };
  if (!response.ok || !body.ok) throw new Error(`${String(command.type)} failed: ${JSON.stringify(body.error ?? body)}`);
  return body.result ?? {};
}

async function stateRows(host: HostHandle): Promise<StateRows> {
  const response = await fetch(`${host.baseUrl}/api/state`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!response.ok) throw new Error(`/api/state failed: ${response.status}`);
  return await response.json() as StateRows;
}

async function workDetail(host: HostHandle, workId: string): Promise<WorkDetailResponse> {
  const response = await fetch(`${host.baseUrl}/api/works/${encodeURIComponent(workId)}`, { headers: { authorization: `Bearer ${host.token}` } });
  if (!response.ok) throw new Error(`/api/works failed: ${response.status}`);
  return await response.json() as WorkDetailResponse;
}

/** Poll until `probe` returns a value; the host settles each turn before answering `message.send`. */
async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(200);
  }
}

async function untilQuiescent(host: HostHandle): Promise<void> {
  await waitFor('every conversation to go quiet', async () => {
    const rows = await stateRows(host);
    return rows.conversations.every(conversation => !conversation.busy) ? rows : null;
  });
}

/** A Work runs in its own lane; wait for it to claim completion and open the owner decision. */
async function untilAcceptance(host: HostHandle, workId: string): Promise<DecisionRow> {
  return await waitFor(`work ${workId} acceptance`, async () => {
    const detail = await workDetail(host, workId);
    if (detail.work.state !== 'verifying') return null;
    return detail.decisions.find(decision => decision.kind === 'accept_result' && decision.state === 'pending') ?? null;
  });
}

export async function seed(host: HostHandle): Promise<SeedResult> {
  // Runtime: one OpenAI-compatible provider pointing at the in-process mock, as the default model.
  await command(host, {
    type: 'provider.upsert',
    id: 'visual_mock',
    kind: 'openai_compatible',
    name: 'Visual Mock',
    baseUrl: host.mockBaseUrl,
    models: [{ id: 'mock-1', name: 'Mock 1', contextWindow: 32_000 }],
    apiKey: 'visual-mock-key',
  });
  await command(host, { type: 'settings.update', defaultModel: { provider: 'visual_mock', model: 'mock-1' } });

  // Team: the bootstrap default Ghost plus two, each with a distinct look.
  const ghosts = (await stateRows(host)).ghosts;
  const defaultGhost = ghosts.find(ghost => ghost.isDefault) ?? ghosts[0];
  if (!defaultGhost) throw new Error('the host did not bootstrap a default Ghost');
  await command(host, {
    type: 'ghost.update',
    ghostId: defaultGhost.id,
    name: '도우미',
    persona: '일정과 보고를 맡는 메인 Ghost입니다.',
    look: { avatarId: null, body: '#5b7fd4', face: 'bars', mark: 'halo' },
  });
  const researchGhostId = String((await command(host, {
    type: 'ghost.create',
    name: '연구원',
    persona: '조사와 자료 정리를 맡는 Ghost입니다.',
    look: { avatarId: null, body: '#c47f3c', shape: 'squircle', face: 'dots', mark: 'headphones' },
  })).ghostId);
  const scribeGhostId = String((await command(host, {
    type: 'ghost.create',
    name: '기록가',
    persona: '회의 기록과 문서를 맡는 Ghost입니다.',
    look: { avatarId: null, body: '#59a08b', shape: 'sheet', face: 'arcs', mark: 'glasses' },
  })).ghostId);

  // Direct conversation with the default Ghost: two owner turns, two streamed replies.
  const conversationA = defaultGhost.directConversationId;
  await command(host, { type: 'message.send', conversationId: conversationA, text: '이번 주에 들어온 요청을 정리해서 우선순위를 알려 줘.' });
  await command(host, { type: 'message.send', conversationId: conversationA, text: '좋아. 중요한 항목은 따로 모아서 보고서 초안으로 만들어 줘.' });

  // A pending question from 연구원: the mock calls ask_owner, the decision stays open.
  const conversationB = String((await command(host, { type: 'conversation.create', ghostId: researchGhostId, title: '방향 점검' })).conversationId);
  await command(host, { type: 'message.send', conversationId: conversationB, text: 'MEDIC-QUESTION 새 조사를 시작하기 전에 방향을 확인하고 싶어.' });
  const question = await waitFor('the pending question', async () => {
    const rows = await stateRows(host);
    return rows.decisions.find(decision => decision.kind === 'question' && decision.state === 'pending') ?? null;
  });

  // Two Works from the conversation. The first completes and is approved; the second waits on its owner.
  const workDoneId = String((await command(host, {
    type: 'work.create',
    ghostId: defaultGhost.id,
    title: '주간 보고 초안',
    brief: 'MEDIC-COMPLETE 이번 주 활동을 요약한 보고 초안을 만들어 줘.',
    originConversationId: conversationA,
  })).workId);
  const acceptanceDone = await untilAcceptance(host, workDoneId);
  await command(host, { type: 'decision.resolve', decisionId: acceptanceDone.id, outcome: 'approve' });
  await waitFor('work to finish', async () => (await workDetail(host, workDoneId)).work.state === 'done' ? true : null);

  const workLiveId = String((await command(host, {
    type: 'work.create',
    ghostId: defaultGhost.id,
    title: '회의 메모 요약',
    brief: 'MEDIC-COMPLETE 어제 회의 메모를 세 문단으로 요약해 줘.',
    originConversationId: conversationA,
  })).workId);
  await untilAcceptance(host, workLiveId);

  // A project space on a stable temp folder, with two saved pages.
  const spaceId = String((await command(host, {
    type: 'space.create',
    name: '비행 기록',
    path: host.spacePath,
  })).spaceId);
  await command(host, {
    type: 'document.save', spaceId, pageId: null, expectedHash: null, profile: 'pdc-markdown/1',
    title: '비행 기록 노트',
    body: '# 비행 기록 노트\n\n시험 비행마다 관측한 값을 한 줄씩 남긴다.\n\n- 이륙 고도와 바람 방향\n- 배터리 잔량과 비행 시간\n- 착륙 지점과 특이 사항\n\n다음 비행 전에 이전 기록을 다시 읽는다.',
  });
  await command(host, {
    type: 'document.save', spaceId, pageId: null, expectedHash: null, profile: 'pdc-markdown/1',
    title: '회의 정리',
    body: '# 회의 정리\n\n- 발사 창구는 오전 바람이 약한 시간대로 잡는다.\n- 기록가는 매 비행 후 30분 안에 초안을 올린다.\n- 연구원은 두 주차 데이터를 비교해 추세를 요약한다.',
  });

  await untilQuiescent(host);
  const finalRows = await stateRows(host);
  const scribe = finalRows.ghosts.find(ghost => ghost.id === scribeGhostId);
  if (!scribe) throw new Error('seeded Ghosts are missing from the snapshot');
  return {
    defaultGhostId: defaultGhost.id,
    researchGhostId,
    scribeGhostId,
    conversationA,
    conversationB,
    workDoneId,
    workLiveId,
    questionDecisionId: question.id,
    spaceId,
  };
}
