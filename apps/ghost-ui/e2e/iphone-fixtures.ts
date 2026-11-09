import type { Page } from '@playwright/test';
import type { Device, InteractiveUi, Message, State } from '@ghost/contract';
import { readRunState } from './run-state';

export async function mockIPhone(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.defineProperty(window, '__GHOST_SHELL__', { value: Object.freeze({ platform: 'ios', version: '1.0', deviceId: 'visual-phone' }) });
    Object.defineProperty(window, '__shellCalls', { value: calls });
    let permission = 'undetermined';
    Object.defineProperty(window, 'webkit', { value: { messageHandlers: { ghostShell: { postMessage: async (request: { type: string }) => {
      calls.push(request);
      if (request.type === 'ready') return { events: [] };
      if (request.type === 'notifications.request') permission = 'allowed';
      if (request.type.startsWith('notifications.') && request.type !== 'notifications.settings') return { status: permission };
      return {};
    } } } } });
  });
  let alerts: Device['alerts'] = { mutedKinds: ['work_done'], mutedGhostIds: [] };
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json() as State;
    // Interaction specs share the isolated host and deliberately leave retained/deleted rows.
    // This visual fixture shows only its three seeded Ghosts and model provider.
    const seed = readRunState();
    const seededGhosts = new Set([seed.defaultGhostId, seed.researchGhostId, seed.scribeGhostId]);
    state.ghosts = state.ghosts.filter(ghost => seededGhosts.has(ghost.id));
    state.settings = { ...state.settings, providers: state.settings.providers.filter(provider => provider.id === 'visual_mock')
      .map(provider => ({ ...provider, baseUrl: provider.baseUrl ? 'http://127.0.0.1:8080/v1' : null })) };
    state.schedules = [];
    state.activities = [];
    state.activityRuns = [];
    state.connections = [];
    const device: Device = { id: 'visual-phone', name: '나의 iPhone', createdAt: 1, lastSeenAt: null, pushEnabled: false, alerts };
    await route.fulfill({ response, json: { ...state, principal: { kind: 'device', deviceId: device.id, name: device.name }, devices: [...state.devices, device] } });
  });
  await page.route('**/api/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.command.type === 'device.alerts_update') {
      alerts = body.command.alerts;
      await route.fulfill({ json: { ok: true, result: {} } });
    } else await route.continue();
  });
}

const presentation: InteractiveUi = { version: 'ghost-ui/1', title: '주간 조사', blocks: [
  { type: 'chart', id: 'chart', title: '처리량', kind: 'bar', unit: '건', series: [{ name: '완료', points: [{ label: '월', value: 12 }, { label: '화', value: 18 }, { label: '수', value: 15 }, { label: '목', value: 23 }] }] },
  { type: 'comparison', id: 'compare', title: '접근 방식 비교', columns: ['속도', '안정성', '운영 비용'], rows: [{ label: '직접 처리', values: ['빠름', '관찰 필요', '낮음'] }, { label: '단계별 검토', values: ['보통', '확인 후 진행', '보통'] }] },
  { type: 'choices', id: 'choices', title: '다음 조사', options: [{ id: 'speed', label: '속도 지표', description: '주요 경로의 처리 시간을 살펴봅니다.' }, { id: 'errors', label: '오류 패턴' }] },
  { type: 'form', id: 'form', title: '조사 범위', fields: [{ id: 'topic', type: 'text', label: '주제', required: true }, { id: 'count', type: 'number', label: '자료 수', value: 5, min: 1 }], submitLabel: '범위 보내기' },
  { type: 'html', id: 'html', title: '보고서 미리보기', html: '<article><h2>이번 주의 기록</h2><p>세 가지 자료를 비교하고 다음 확인 항목을 정리했습니다.</p><table><tr><th>항목</th><th>관찰</th></tr><tr><td>처리 시간</td><td>핵심 경로를 먼저 확인</td></tr></table></article>' },
] };
export async function mockRichConversation(page: Page) {
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ response, json: { ...state, decisions: [], works: [] } });
  });
  const files = [
    { name: '자료.svg', mediaType: 'image/svg+xml', digest: 'a'.repeat(64), content: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e9eee9"/><circle cx="300" cy="170" r="80" fill="#718d75"/><path d="M170 310h260" stroke="#718d75" stroke-width="16"/></svg>' },
    { name: '기록.md', mediaType: 'text/markdown', digest: 'b'.repeat(64), content: '# 조사 기록\n\n자료를 비교하고 확인할 내용을 정리했습니다.\n\n| 항목 | 관찰 | 다음 단계 |\n| --- | --- | --- |\n| 속도 | 핵심 경로 | 실제 요청 비교 |\n\n```ts\nconst next = \"compare\";\n```' },
    { name: '자료.pdf', mediaType: 'application/pdf', digest: 'c'.repeat(64), content: '' },
  ];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 22 Tf 36 340 Td (Ghost document) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  files[2].content = pdf;
  for (const file of files) await page.route(`**/api/artifacts/${file.digest}`, route => route.fulfill({ contentType: file.mediaType, body: file.content }));
  await page.route('**/api/conversations/*?*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const conversationId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const base = { conversationId, toolCalls: [], origin: null, attachments: [], createdAt: 1 };
    const messages: Message[] = [
      { ...base, id: 'mobile-presentation', role: 'tool', text: JSON.stringify(presentation), tool: { name: 'present_ui', callId: 'mobile-call', isError: false } },
      { ...base, id: 'mobile-markdown', role: 'assistant', tool: null, text: '## 비교 메모\n\n| 항목 | 관찰 내용 | 다음 확인 | 담당 |\n| --- | --- | --- | --- |\n| 처리 시간 | 핵심 경로의 지연 | 실제 요청과 비교 | 연구원 |\n| 오류 기록 | 반복되는 실패 | 재현 조건 확인 | 기록가 |\n\n```ts\nconst observation = { latency: 42, source: "verified-sample", next: "compare" };\n```\n\n[참고 자료](https://example.com/report)' },
    ];
    messages[1].attachments = files.map(file => ({ name: file.name, mediaType: file.mediaType, digest: file.digest, size: new TextEncoder().encode(file.content).length }));
    const submitted = (data.messages as Message[]).filter(message => message.role === 'user' && message.text.startsWith('UI 응답 · 주간 조사'));
    await route.fulfill({ response, json: { ...data, messages: [...messages, ...submitted], before: null, live: null } });
  });
}

export async function mockMessageNotification(page: Page) {
  await mockIPhone(page);
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json() as State;
    const seed = readRunState();
    await route.fulfill({ response, json: { ...state, works: [], decisions: [], notifications: [{
      id: 'visual-message', kind: 'message', ghostId: seed.defaultGhostId, conversationId: seed.conversationA,
      decisionId: null, workId: null, title: '도우미', body: '아침에 확인한 자료를 정리했어요. 가장 중요한 변화부터 전해드릴게요.',
      createdAt: seed.fixedNow - 30_000, readAt: null,
    }] } });
  });
  await page.route('**/api/commands', async route => {
    const command = route.request().postDataJSON()?.command;
    if (command?.type === 'notification.read' && command.notificationIds.includes('visual-message')) await route.fulfill({ json: { ok: true, result: {} } });
    else await route.fallback();
  });
}

export async function mockConversationActivity(page: Page) {
  await page.route('**/api/conversations/*?*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    const conversationId = data.conversation.id;
    const base = { conversationId, role: 'tool', origin: null, toolCalls: [], attachments: [], createdAt: readRunState().fixedNow - 1000 };
    await route.fulfill({ response, json: { ...data, messages: [...data.messages,
      { ...base, id: 'audit-read', text: '세 가지 자료를 읽고 중요한 차이를 정리했습니다.', tool: { name: 'document_read', callId: 'audit-read', isError: false } },
      { ...base, id: 'audit-search', text: '일치하는 자료가 없습니다. 다른 검색어로 확인합니다.', tool: { name: 'web_search', callId: 'audit-search', isError: false } },
    ], live: { conversationId, running: true, partial: '자료를 비교하고 있어요. 확인이 필요한 차이부터 정리해서 전해드릴게요.', thinking: '자료의 날짜와 출처를 비교했습니다.', tools: [{ callId: 'audit-live', name: 'web_read', output: '자료 본문을 읽고 있습니다.' }] } } });
  });
}
