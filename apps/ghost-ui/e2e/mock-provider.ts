import { createServer, type Server } from 'node:http';

/**
 * Tiny OpenAI-compatible chat completions mock the host talks to through
 * pi-ai's `openai_compatible` provider kind (`POST {baseUrl}/chat/completions`,
 * SSE streaming). Replies are keyed off the last message of the request so the
 * seeded fixtures drive deterministic turns:
 *
 * - `MEDIC-COMPLETE` in the prompt → `complete` tool call (finishes the Work).
 * - `MEDIC-QUESTION` in the prompt → `ask_owner` tool call (opens a decision).
 * - anything else → `reasoning_content` + a fixed Korean text reply.
 * - a tool result last → the follow-up text reply ending the turn.
 */

export interface MockProvider { port: number; stop(): Promise<void>; }

let active: Server | null = null;

const CHUNK_ID = 'chatcmpl-visual';
const MODEL = 'mock-1';

interface ChatMessage { role: string; content: unknown; }

type MockReply =
  | { kind: 'text'; withThinking: boolean; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> };

const COMPLETE_SUMMARY = '요청한 문서를 작성해 결과로 남겼어요. 요약과 다음 단계가 들어갑니다.';
const QUESTION = '어떤 항목부터 조사할까요?';
const QUESTION_OPTIONS = ['속도 지표', '오류 패턴', '사용자 요청'];
const AFTER_QUESTION = '물어봐 주셔서 감사해요. 답변을 기다리는 동안 관련 자료를 정리해 둘게요.';
/** A model that quotes the Work id back, as real ones do: the transcript must show it as a mark, not characters. */
const afterReport = (workId: string) => `보고 확인했어요. 결과(${workId})는 맡긴 일에서 볼 수 있어요.`;
const THINKING = '요청을 한 문단으로 정리해 답하자. 확인 가능한 것만 말하고, 새로운 사실은 만들지 않는다.';
const REPLY = '이번 주에는 세 가지 요청이 들어왔어요. 보고서 초안과 메모 요약부터 진행하고, 나머지는 다음 주로 미뤘어요.';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part !== null && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

/** What the mock should answer, from the last transcript entry. */
function replyFor(messages: ChatMessage[]): MockReply {
  const last = messages[messages.length - 1];
  const lastText = textOf(last?.content);
  if (last?.role === 'tool') return { kind: 'text', withThinking: false, text: AFTER_QUESTION };
  if (lastText.startsWith('Work "')) return { kind: 'text', withThinking: false, text: afterReport(/\(([0-9a-f-]{36})\)/.exec(lastText)?.[1] ?? '') };
  if (lastText.includes('MEDIC-COMPLETE')) return { kind: 'tool', name: 'complete', args: { summary: COMPLETE_SUMMARY, artifacts: [] } };
  if (lastText.includes('MEDIC-QUESTION')) return { kind: 'tool', name: 'ask_owner', args: { question: QUESTION, options: QUESTION_OPTIONS } };
  return { kind: 'text', withThinking: true, text: REPLY };
}

function chunk(sequence: number, delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>): string {
  const body: Record<string, unknown> = {
    id: CHUNK_ID,
    object: 'chat.completion.chunk',
    created: 1_762_500_000,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  return `data: ${JSON.stringify(body)}\n\n`;
}

/** One SSE response, streamed in small pieces so the host exercises its live path. */
async function writeStream(response: ServerResponse, reply: MockReply): Promise<void> {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const frame = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>) => {
    response.write(chunk(0, delta, finishReason, usage));
  };
  if (reply.kind === 'text') {
    if (reply.withThinking) for (const piece of THINKING.match(/.{1,24}/g) ?? []) frame({ reasoning_content: piece }, null);
    for (const piece of reply.text.match(/.{1,24}/g) ?? []) frame({ content: piece }, null);
    frame({}, 'stop', { prompt_tokens: 128, completion_tokens: 48, total_tokens: 176 });
  } else {
    const args = JSON.stringify(reply.args);
    frame({ tool_calls: [{ index: 0, id: `call_${reply.name}`, type: 'function', function: { name: reply.name, arguments: '' } }] }, null);
    for (const piece of args.match(/.{1,24}/g) ?? []) frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }, null);
    frame({}, 'tool_calls', { prompt_tokens: 192, completion_tokens: 32, total_tokens: 224 });
  }
  response.write('data: [DONE]\n\n');
  await new Promise(resolve => response.end(resolve));
}

/** Start listening on a spare loopback port; keeps the runner process alive. */
export function startMockProvider(): Promise<MockProvider> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const body: Buffer[] = [];
    request.on('data', piece => body.push(piece));
    request.on('end', () => {
      let messages: ChatMessage[] = [];
      try {
        messages = (JSON.parse(Buffer.concat(body).toString('utf8')) as { messages?: ChatMessage[] }).messages ?? [];
      } catch {
        // An unreadable body gets the plain text reply; the host surfaces whatever it decides.
      }
      void writeStream(response, replyFor(messages)).catch(() => response.destroy());
    });
    request.on('error', () => response.destroy());
  });
  active = server;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock provider did not bind a TCP port'));
        return;
      }
      const stopped = Promise.withResolvers<void>();
      server.once('close', () => stopped.resolve());
      resolve({
        port: address.port,
        stop: () => {
          server.closeAllConnections();
          server.close();
          return stopped.promise;
        },
      });
    });
  });
}

/** Close the mock started by setup; safe when setup never got that far. */
export async function stopMockProvider(): Promise<void> {
  if (active) {
    active.closeAllConnections();
    active.close();
    active = null;
  }
  await Promise.resolve();
}
