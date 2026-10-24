/**
 * Ghost chat overlay. Lives in the desktop app's second webview: a small
 * always-on-top window the native side parks off-screen and surfaces over the
 * current work. Same console origin, so the bridge CSRF, routing contract and
 * pending-turn journal are identical to the main console; showing/hiding stays
 * native (src-tauri main.rs), Esc included.
 */
import { CommandQueue, connect, RoutingPending, RoutingTerminal } from '../client/api';
import { RoutingClient } from '../client/routingClient';
import { isRunning, phaseLabel, type Client, type Profile, type Snapshot } from '../client/types';
import type { RoutingTurn } from '../client/routingTypes';
import './overlay.css';

// Known static overlay markup; getElementById is untyped.
const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const logEl = document.getElementById('log') as HTMLOListElement;
const composerEl = document.getElementById('composer') as HTMLFormElement;
const titleEl = document.getElementById('title') as HTMLHeadingElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLOutputElement;

type Target = { profile_id?: string; conversation_id?: string };

// Tauri 2 injects this IPC bridge into every webview; the overlay only calls
// the window hide command that the capability grants.
interface TauriInternals {
  invoke(command: string): Promise<void>;
}
const tauri = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

let client: Client | null = null;
let routing: RoutingClient | null = null;
let workspaceId = '';
let target: Target = {};
let profile: Profile | null = null;
let conversationId = '';
let sending = false;
let renderedSignature = '';
let lastSnapshot: Snapshot | null = null;

const targetKey = (workspace: string) => `ghost-overlay:${workspace}`;

function loadTarget(workspace: string): Target {
  try {
    return JSON.parse(localStorage.getItem(targetKey(workspace)) || '{}') as Target;
  } catch {
    return {};
  }
}

function saveTarget() {
  if (workspaceId) localStorage.setItem(targetKey(workspaceId), JSON.stringify(target));
}

function pickProfile(snapshot: Snapshot): Profile | null {
  const wanted = target.profile_id;
  return (
    snapshot.profiles.find(p => p.id === wanted) ??
    snapshot.profiles.find(p => p.name === 'primary') ??
    snapshot.profiles.find(p => p.name === wanted) ??
    snapshot.profiles[0] ??
    null
  );
}

function pickConversation(next: Profile): string {
  if (target.conversation_id && next.conversations.some(c => c.id === target.conversation_id)) {
    return target.conversation_id;
  }
  // Conversation ids are UUIDv7, so the lexicographic maximum is newest.
  return next.conversations.map(c => c.id).sort().at(-1) ?? '';
}

function currentConversation(snapshot: Snapshot | null) {
  return snapshot?.profiles
    .find(p => p.id === profile?.id)
    ?.conversations.find(c => c.id === conversationId);
}

async function ensureConversation(snapshot: Snapshot): Promise<void> {
  const next = pickProfile(snapshot);
  if (!next) {
    status('등록된 Ghost가 없습니다.');
    return;
  }
  let changed = false;
  if (next.id !== profile?.id) {
    profile = next;
    changed = true;
  }
  const found = pickConversation(next);
  if (found !== conversationId) {
    conversationId = found;
    changed = true;
  }
  if (!conversationId) {
    const result: unknown = await client!.action({
      request_id: crypto.randomUUID(),
      command: {
        type: 'create_conversation',
        profile_id: profile.id,
        model: snapshot.default_model,
        tools: true,
      },
    });
    if (
      !(
        result &&
        typeof result === 'object' &&
        'conversation_id' in result &&
        typeof result.conversation_id === 'string'
      )
    ) {
      throw new Error('새 대화를 만들지 못했습니다.');
    }
    conversationId = result.conversation_id;
    changed = true;
  }
  if (workspaceId !== snapshot.workspace_id) {
    workspaceId = snapshot.workspace_id;
    changed = true;
  }
  if (changed) {
    target = { profile_id: profile.id, conversation_id: conversationId };
    saveTarget();
  }
}

function status(text: string) {
  statusEl.textContent = text;
}

function setDot(kind: 'idle' | 'busy' | 'error') {
  dotEl.className = kind;
}

function escapeHtml(text: string) {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML;
}

function render() {
  if (!profile || !conversationId) return;
  const conversation = currentConversation(lastSnapshot);
  const rows: string[] = [];
  for (const message of conversation?.messages ?? []) {
    if (message.role === 'user' && message.text.trim()) {
      rows.push(`<li class="row user"><div>${escapeHtml(message.text)}</div></li>`);
    } else if (message.role === 'assistant' && message.text.trim()) {
      rows.push(`<li class="row ghost"><div>${escapeHtml(message.text)}</div></li>`);
    }
  }
  const running = (conversation?.tasks ?? []).filter(t => isRunning(t.phase)).at(-1);
  if (running) {
    const partial = running.partial.trim() || `${phaseLabel(running.phase)}…`;
    rows.push(`<li class="row ghost working"><div>${escapeHtml(partial)}</div></li>`);
  }
  const body = rows.length
    ? rows.join('')
    : '<li class="empty">주 Ghost와의 대화가 여기에 표시됩니다.</li>';
  const signature = running ? `working:${body}` : body;
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = body;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  setDot(running ? 'busy' : 'idle');
  sendEl.disabled = sending || !conversationId;
  titleEl.textContent = profile.name === 'primary' ? 'Ghost' : `Ghost · ${profile.name}`;
}

async function send(text: string) {
  if (!client || !profile || !conversationId || sending || !text.trim()) return;
  sending = true;
  setDot('busy');
  status('보내는 중…');
  const kind = (currentConversation(lastSnapshot)?.messages.length ?? 0)
    ? ('follow_up' as const)
    : ('prompt' as const);
  try {
    if (routing && client.routing?.canPrepareInput) {
      const turn: RoutingTurn = {
        entry: { entry_profile_id: profile.id, conversation_id: conversationId },
        text,
        kind,
        resolves: [],
      };
      await routing.submit(turn);
    } else {
      await client.action({
        request_id: crypto.randomUUID(),
        command: {
          type: 'submit',
          profile_id: profile.id,
          conversation_id: conversationId,
          prompt: text,
          kind: kind === 'follow_up' ? 'steer' : 'prompt',
        },
      });
    }
    status('');
  } catch (error) {
    // Direct-answer turns end without an admission; the console keeps the
    // turn alive through the pending journal and snapshot polling, and so
    // does this overlay. Only unexpected failures surface here.
    if (!(error instanceof RoutingPending) && !(error instanceof RoutingTerminal)) {
      setDot('error');
      status(error instanceof Error ? error.message : '보내지 못했습니다.');
    } else {
      status('');
    }
  } finally {
    sending = false;
    render();
  }
}

async function poll() {
  if (!client || document.hidden) return;
  try {
    const snapshot = await client.snapshot();
    lastSnapshot = snapshot;
    await ensureConversation(snapshot);
    render();
  } catch (error) {
    setDot('error');
    status(error instanceof Error ? error.message : '연결을 확인해 주세요.');
  }
}

function autoresize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 132)}px`;
}

async function start() {
  try {
    client = await connect();
    const snapshot = await client.snapshot();
    workspaceId = snapshot.workspace_id;
    target = loadTarget(workspaceId);
    if (client.routing?.canPrepareInput) {
      routing = new RoutingClient(
        client.routing,
        new CommandQueue(localStorage, `ghost-overlay:pending:${workspaceId}`),
      );
    }
    await ensureConversation(snapshot);
    lastSnapshot = snapshot;
    render();
    setDot('idle');
  } catch (error) {
    setDot('error');
    status(error instanceof Error ? error.message : 'Ghost 호스트에 연결하지 못했습니다.');
  }
  void setInterval(() => void poll(), 1500);
}

composerEl.addEventListener('submit', event => {
  event.preventDefault();
  const text = inputEl.value;
  inputEl.value = '';
  autoresize();
  void send(text);
});

inputEl.addEventListener('input', autoresize);
inputEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') void tauri?.invoke('plugin:window|hide');
});
window.addEventListener('focus', () => inputEl.focus());

void start();
