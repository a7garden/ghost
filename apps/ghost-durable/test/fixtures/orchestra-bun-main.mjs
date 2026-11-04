// A disposable compiled test entry. Every real provider URL is intercepted;
// only the fixture Host's literal loopback callbacks reach the network.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const originalFetch = globalThis.fetch;
const ownerMarker = 'ORCHESTRA_E2E_OWNER';
const workMarker = 'ORCHESTRA_E2E_WORK';
const answer = 'orchestra-e2e-artifact';

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (new URL(request.url).hostname === '127.0.0.1') return originalFetch(request);
  const reviewer = request.url === 'https://api.minimax.io/v1/responses';
  if (!reviewer && request.url !== 'https://api.z.ai/api/v1/responses') throw new Error('Unexpected network route.');
  const body = await request.json();
  const frame = JSON.stringify(body.input);
  const tools = (body.tools ?? []).map(tool => tool.name);
  const seen = (name) => body.input.some(item => item.type === 'function_call' && item.name === name &&
    body.input.some(result => result.type === 'function_call_output' && result.call_id === item.call_id));
  const assignment = frame.includes('Current authenticated Goal assignment:');
  const owner = frame.includes(ownerMarker) && frame.includes('Current authenticated input kind: owner.');
  const verified = frame.includes('Independent Orchestra Pi review passed:');
  const pendingReport = frame.includes('Authoritative Host report for work');
  const intake = frame.includes('orchestra_task') && frame.includes('routine-code');
  const credentialMatches = request.headers.get('authorization') ===
    (reviewer ? 'Bearer orchestra-fixture-reviewer' : 'Bearer orchestra-fixture-producer');
  await appendFile(join(process.env.GHOST_LIFETIME_HOST_ROOT, 'orchestra-provider-trace.jsonl'),
    JSON.stringify({ reviewer, owner, assignment, intake, verified, model: body.model,
      effort: body.reasoning?.effort, credentialMatches, tools, store: body.store,
      containsOwnerTurn: frame.includes(ownerMarker), containsArtifact: frame.includes(answer) }) + '\n');

  let item;
  const text = content => ({ type: 'message', id: 'msg_orchestra', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: content, annotations: [] }] });
  const call = (name, args) => ({ type: 'function_call', id: `fc_${name}`, call_id: `call_${name}`,
    name, arguments: JSON.stringify(args), status: 'completed' });
  if (reviewer) {
    if (tools.length || body.store !== false || frame.includes(ownerMarker) || !frame.includes(answer) ||
        !frame.includes(workMarker) || !credentialMatches) throw new Error('Independent reviewer received an invalid scope.');
    item = text(JSON.stringify({ verdict: 'pass', summary: 'The exact published text matches the requirement.' }));
  } else if (assignment) {
    if (body.model !== 'glm-5.3' || body.reasoning?.effort !== 'max' || !frame.includes(workMarker)) {
      throw new Error('The assignment did not use its pinned task route.');
    }
    if (!seen('write')) item = call('write', { path: 'answer.txt', content: answer });
    else if (!seen('publish_artifact')) item = call('publish_artifact', { path: 'answer.txt', privacy: 'public' });
    else item = text('산출물을 게시했습니다.');
  } else if (verified) {
    item = text('독립 Pi 리뷰를 통과했습니다. 산출물을 게시했으며 소유자 수용을 기다립니다.');
  } else if (pendingReport) {
    item = text('산출물이 게시됐으며 리뷰를 기다리고 있습니다.');
  } else if (owner) {
    if (!intake || body.reasoning?.effort !== 'low' || !credentialMatches) throw new Error('Missing original Orchestra intake.');
    item = seen('goal_create') ? text('작업 스레드를 열었습니다.') : call('goal_create', {
      prompt: `${workMarker} Publish a text artifact with exactly ${answer}.`,
      acceptance_spec: { orchestra_task: 'routine-code' },
    });
  } else {
    item = text('업무 상태를 확인했습니다.');
  }
  const response = { id: 'resp_orchestra', status: 'completed', output: [item],
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } };
  const events = [
    { type: 'response.created', response: { id: response.id } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
};

await import('../../src/main.js');
