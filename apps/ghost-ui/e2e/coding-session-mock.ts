import type { Page } from '@playwright/test';
import type { CodingDialog, CodingDialogAnswer, CodingEvent, CodingItem, CodingPrompt, CodingSession, CodingSessionCreate } from '@ghost/contract';

const at = Date.UTC(2026, 10, 23, 3);
export const sampleSession: CodingSession = {
  id: 'coding-embedded-login', title: '로그인 화면 다듬기', state: 'working', cwd: '/test/worktrees/ghost-login', repo: '/test/repos/ghost',
  branch: 'ghost/login-layout', base: 'base', model: { provider: 'sample', model: 'atlas' }, thinking: 'medium', workId: null, ghostId: null, turn: 1,
  pendingDialog: null, usage: { input: 0, output: 0, cost: 0 }, createdAt: at, updatedAt: at,
};
const models = [
  { provider: 'sample', model: 'atlas', name: 'Atlas', thinking: ['off', 'low', 'medium', 'high'] },
  { provider: 'sample', model: 'sparrow', name: 'Sparrow', thinking: ['off', 'low'] },
];
export const partialReply: Extract<CodingItem, { kind: 'assistant' }> = { id: 'reply', kind: 'assistant', at, streaming: true, text: '로그인 흐름을 확인하고 있습니다.' };
export const editTool: Extract<CodingItem, { kind: 'tool' }> = {
  id: 'edit', kind: 'tool', at, tool: 'edit', summary: 'edit src/login.ts', status: 'running', output: '', images: [],
};
export const loginDiff = 'diff --git a/src/login.ts b/src/login.ts\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1 +1 @@\n-const mode = "classic";\n+const mode = "focused";';
export const attachmentB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a31cAAAAASUVORK5CYII=';

const thumb = (background: string, accent: string, title: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <rect width="640" height="400" fill="${background}"/><rect x="92" y="64" width="456" height="272" rx="24" fill="white"/>
  <text x="138" y="132" fill="#222530" font-family="sans-serif" font-size="26">${title}</text>
  <rect x="138" y="163" width="364" height="34" rx="7" fill="#eaeaf0"/>
  <rect x="138" y="211" width="364" height="34" rx="7" fill="#eaeaf0"/>
  <rect x="138" y="266" width="160" height="32" rx="8" fill="${accent}"/>
</svg>`;

const htmlMockup = `<!doctype html><html><head><style>
  body{background:#eef0fb;color:#242949}main{max-width:460px;margin:50px auto;padding:34px;background:#fff;border-radius:20px}
  h1{margin:0 0 18px}.input{height:24px;padding:8px 11px;margin:8px 0;background:#eeeefa;border-radius:6px}.action{display:inline-block;background:#4354bd;color:white;padding:7px 20px;border-radius:9px;margin-top:8px}
  .action{background-image:url(https://coding-preview-never.invalid/style.png)}
</style><meta http-equiv="refresh" content="0;url=https://coding-preview-never.invalid/refresh"></head><body>
<main><h1>한 줄 로그인</h1><p class="input">이메일</p><span class="action">계속</span></main>
<img src="https://coding-preview-never.invalid/image.png"><script>document.body.innerText='SCRIPT RAN';</script></body></html>`;

const choices: CodingDialog = {
  id: 'mockups', kind: 'choices', title: '로그인 목업 고르기', message: '진행할 시안을 골라 주세요.', createdAt: at, allowText: true,
  options: [
    { id: 'focused', label: '집중형', image: { path: 'focused.svg', mimeType: 'image/svg+xml' } },
    { id: 'quiet', label: '여백형', image: { path: 'quiet.svg', mimeType: 'image/svg+xml' } },
    { id: 'compact', label: '간결형', html: 'compact.html' },
  ],
};
const approval: CodingDialog = {
  id: 'approval', kind: 'approval', title: '도구 실행 확인', createdAt: at,
  tool: { name: 'bash', summary: 'bun run screenshot --output /tmp/login.png' },
};

export async function mockCodingSessions(page: Page) {
  const sessions = new Map<string, CodingSession>([[sampleSession.id, sampleSession]]);
  const items = new Map<string, Map<string, CodingItem>>([[sampleSession.id, new Map([
    { id: 'previous-user', at, kind: 'user', text: '로그인 화면을 다듬어 주세요.', images: [] },
    { id: 'thought', at, kind: 'thinking', streaming: false, text: '현재 로그인 흐름과 회귀 가능성을 살핀다.' },
    partialReply, editTool,
    { id: 'scout', at, kind: 'subagent', role: 'scout', task: '다른 로그인 진입점 확인', status: 'done', summary: '경로 2곳 확인' },
    { id: 'scout-read', at, kind: 'tool', tool: 'read', summary: 'read src/routes.ts', status: 'done', output: '로그인 경로', images: [], subagent: 'scout' },
  ].map((item): [string, CodingItem] => [item.id, item as CodingItem]))]]);
  const prompts: CodingPrompt[] = [];
  const answers: { id: string; input: CodingDialogAnswer }[] = [];
  const creates: CodingSessionCreate[] = [];
  const patches: unknown[] = [];
  let aborts = 0;
  let historyReads = 0;
  let changesReads = 0;
  let diff = loginDiff;

  // Playwright routes fulfill finite bodies. Keep their first SSE frame, then deliver live frames
  // through the same fetch stream until a deliberate disconnect or the app's AbortSignal.
  await page.addInitScript(() => {
    const fetchImpl = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      const path = new URL(response.url || location.href).pathname;
      const match = /^\/api\/coding\/sessions\/([^/]+)\/events$/.exec(path);
      if (!response.ok || !match) return response;
      const id = decodeURIComponent(match[1]!);
      const initial = await response.text();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const signal = init?.signal;
          const close = () => { detach(); controller.close(); };
          const receive = (event: Event) => {
            const { sessionId, frame } = (event as CustomEvent<{ sessionId: string; frame: string | null }>).detail;
            if (sessionId !== id) return;
            if (frame === null) close();
            else controller.enqueue(encoder.encode(frame));
          };
          const detach = () => {
            window.removeEventListener('coding-session-fixture', receive);
            signal?.removeEventListener('abort', close);
          };
          controller.enqueue(encoder.encode(initial));
          if (signal?.aborted) close();
          else {
            window.addEventListener('coding-session-fixture', receive);
            signal?.addEventListener('abort', close, { once: true });
          }
        },
      });
      return new Response(stream, { headers: response.headers });
    };
  });
  const frame = (event: CodingEvent) => `data: ${JSON.stringify(event)}\n\n`;
  const emit = (id: string, event: CodingEvent | null) => page.evaluate(detail => {
    window.dispatchEvent(new CustomEvent('coding-session-fixture', { detail }));
  }, { sessionId: id, frame: event && frame(event) });
  const saveSession = async (id: string, patch: Partial<CodingSession>, notify = true) => {
    const session = { ...sessions.get(id)!, ...patch };
    sessions.set(id, session);
    if (notify) await emit(id, { type: 'session', session });
    return session;
  };
  const saveItem = async (id: string, item: CodingItem, notify = true) => {
    items.get(id)!.set(item.id, item);
    if (notify) await emit(id, { type: 'item', item });
  };

  await page.route('**/api/coding/models', route => route.fulfill({ json: { models, last: { provider: 'sample', model: 'sparrow', thinking: null } } }));
  await page.route('**/api/coding/sessions', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [...sessions.values()] });
    const input = route.request().postDataJSON() as CodingSessionCreate;
    creates.push(input);
    const session: CodingSession = { ...sampleSession, id: `new-${creates.length}`, title: '새 작업 트리', branch: 'ghost/new-worktree', repo: input.repo ?? null,
      model: input.model ?? sampleSession.model, thinking: input.thinking ?? 'off', turn: 0, state: 'idle' };
    sessions.set(session.id, session);
    items.set(session.id, new Map());
    await route.fulfill({ status: 201, json: session });
  });
  await page.route(/\/api\/coding\/sessions\/[^/?]+(?:[/?]|$)/, async route => {
    const url = new URL(route.request().url());
    const [, , , , id, ...tail] = url.pathname.split('/');
    const session = sessions.get(id!);
    if (!session) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '세션을 찾을 수 없습니다.' } } });
    switch (tail[0]) {
      case 'events': return route.fulfill({ contentType: 'text/event-stream', body: frame({ type: 'session', session }) });
      case 'items': {
        historyReads += 1;
        const history = [...items.get(session.id)!.values()];
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const after = url.searchParams.get('after');
        const start = after === null ? Math.max(0, history.length - limit) : after === '' ? 0 : history.findIndex(item => item.id === after) + 1;
        return route.fulfill({ json: { items: history.slice(start, start + limit) } });
      }
      case 'prompt': {
        const input = route.request().postDataJSON() as CodingPrompt;
        prompts.push(input);
        if (input.mode === 'prompt') {
          const images = input.images?.map(image => ({ path: image.name ?? 'owner.png', mimeType: image.mimeType, label: image.name })) ?? [];
          await saveItem(session.id, { id: `prompt-${prompts.length}`, kind: 'user', at, text: input.text, images });
          await saveSession(session.id, { state: images.length ? 'waiting' : 'working', pendingDialog: images.length ? choices : null });
        }
        return route.fulfill({ json: { disposition: input.mode === 'prompt' ? 'started' : 'queued' } });
      }
      case 'dialogs': {
        const input = route.request().postDataJSON() as CodingDialogAnswer;
        answers.push({ id: tail[1]!, input });
        await saveSession(session.id, { state: 'working', pendingDialog: null });
        return route.fulfill({ json: { ok: true } });
      }
      case 'abort': {
        aborts += 1;
        await saveItem(session.id, { id: 'aborted', at, kind: 'notice', text: '요청으로 작업을 중단했습니다.', level: 'error' });
        return route.fulfill({ json: await saveSession(session.id, { state: 'failed', pendingDialog: null }) });
      }
      case 'close': return route.fulfill({ json: await saveSession(session.id, { state: 'closed', pendingDialog: null }) });
      case 'changes': {
        changesReads += 1;
        return route.fulfill({ json: { files: [{ path: 'src/login.ts', status: 'modified', additions: 1, deletions: 1 }], diff, truncated: false, commits: [], dirty: true } });
      }
      case 'file': {
        const path = url.searchParams.get('path');
        if (path === 'compact.html') return route.fulfill({ contentType: 'text/html', body: htmlMockup });
        if (path === 'focused.svg') return route.fulfill({ contentType: 'image/svg+xml', body: thumb('#ebedf8', '#4354bd', '집중형 로그인') });
        if (path === 'quiet.svg') return route.fulfill({ contentType: 'image/svg+xml', body: thumb('#f5ede5', '#745442', '여백형 로그인') });
        if (path === 'owner.png') return route.fulfill({ contentType: 'image/png', body: Buffer.from(attachmentB64, 'base64') });
        return route.fulfill({ status: 404 });
      }
      default:
        if (route.request().method() === 'PATCH') {
          const patch = route.request().postDataJSON() as Partial<CodingSession>;
          patches.push(patch);
          return route.fulfill({ json: await saveSession(session.id, patch) });
        }
        return route.fulfill({ json: session });
    }
  });

  return {
    prompts, answers, creates, patches,
    get aborts() { return aborts; },
    get historyReads() { return historyReads; },
    get changesReads() { return changesReads; },
    patch: (patch: Partial<CodingSession>) => saveSession(sampleSession.id, patch),
    item: (item: CodingItem) => saveItem(sampleSession.id, item),
    showApproval: () => saveSession(sampleSession.id, { state: 'waiting', pendingDialog: approval }),
    async updateChanges() {
      diff = loginDiff.replace('focused', 'revised');
      await saveItem(sampleSession.id, { ...editTool, status: 'done', diff });
    },
    async dropStream() {
      await saveItem(sampleSession.id, { id: 'host-restart', at, kind: 'notice', text: 'Host가 다시 시작되어 턴이 중단되었습니다.', level: 'error' }, false);
      await saveSession(sampleSession.id, { state: 'failed', pendingDialog: null }, false);
      await emit(sampleSession.id, null);
    },
  };
}
