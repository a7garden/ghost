/**
 * Ghost chat overlay. Lives in the desktop app's second webview: a small
 * always-available composer into the default Ghost's direct conversation.
 */
import { HostClient } from '../host/client';
import type { Message, State } from '@ghost/contract';
import { pickConversation, pickGhost, type Target } from './target';
import '@garden/ui/styles.css';
import './overlay.css';
import { installWindowDrag } from '../host/windowDrag';

// Garden tokens switch on the root `.dark` class; the overlay follows the system theme.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', systemDark.matches);
applyTheme();
systemDark.addEventListener('change', applyTheme);

// Known static overlay markup; getElementById is untyped.
const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const logEl = document.getElementById('log') as HTMLOListElement;
const composerEl = document.getElementById('composer') as HTMLFormElement;
const titleEl = document.getElementById('title') as HTMLHeadingElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLOutputElement;

// Tauri 2 injects this IPC bridge into every webview; the overlay only calls
// the window hide and title bar drag commands that the capability grants.
interface TauriInternals {
  invoke(command: string): Promise<void>;
}
const tauri = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
if (tauri) installWindowDrag(command => tauri.invoke(command));

let client: HostClient | null = null;
let state: State | null = null;
let ghostId = '';
let conversationId = '';
let messages: Message[] = [];
let busy = false;
let sending = false;
let renderedSignature = '';

const targetKey = 'ghost-overlay:target';

function loadTarget(): Target {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(targetKey) || '{}');
    if (typeof raw !== 'object' || raw === null) return {};
    const ghostId = 'ghostId' in raw && typeof raw.ghostId === 'string' ? raw.ghostId : undefined;
    const conversationId = 'conversationId' in raw && typeof raw.conversationId === 'string' ? raw.conversationId : undefined;
    return { ghostId, conversationId };
  } catch {
    return {};
  }
}

function saveTarget(target: Target) {
  try { localStorage.setItem(targetKey, JSON.stringify(target)); } catch { /* The default target still works. */ }
}

async function initialize(): Promise<void> {
  client = new HostClient();
  await refresh();
  setDot('idle');
}

/** One read pass: state snapshot, then the target conversation's transcript. */
async function refresh(): Promise<void> {
  if (!client) return;
  const next = await client.state();
  state = next;
  const target = loadTarget();
  const ghost = pickGhost(next, target.ghostId);
  if (!ghost) {
    status('등록된 Ghost가 없습니다.');
    return;
  }
  const stored = pickConversation(next, ghost, target.conversationId);
  if (ghost.id !== ghostId || stored !== conversationId) {
    ghostId = ghost.id;
    conversationId = stored;
    messages = [];
    saveTarget({ ghostId, conversationId });
  }
  const page = await client.conversation(conversationId);
  messages = page.messages;
  busy = page.conversation.busy;
  const runtime = next.runtime.ready ? '' : `대화를 실행할 수 없습니다. ${next.runtime.detail}`;
  if (!sending) status(runtime);
  render();
}

function status(text: string) {
  statusEl.textContent = text;
}

function setDot(kind: 'idle' | 'busy' | 'error') {
  dotEl.className = kind;
}

// Element-content interpolation only: textContent round-trip does not escape
// quotes, so never reuse this for an attribute value.
function escapeHtml(text: string) {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML;
}

function render() {
  if (!state || !conversationId) return;
  const rows: string[] = [];
  for (const message of messages) {
    if (message.role === 'user' && message.text.trim()) rows.push(`<li class="row user"><div>${escapeHtml(message.text)}</div></li>`);
    else if (message.role === 'assistant' && message.text.trim()) rows.push(`<li class="row ghost"><div>${escapeHtml(message.text)}</div></li>`);
  }
  if (busy) rows.push('<li class="row ghost working"><div>응답 작성 중…</div></li>');
  const body = rows.length ? rows.join('') : '<li class="empty">주 Ghost와의 대화가 여기에 표시됩니다.</li>';
  const signature = busy ? `working:${body}` : body;
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = body;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  setDot(busy ? 'busy' : 'idle');
  sendEl.disabled = sending || !conversationId;
  const ghost = pickGhost(state, ghostId);
  titleEl.textContent = ghost && !ghost.isDefault ? `Ghost · ${ghost.name}` : 'Ghost';
}

async function send(text: string) {
  if (!client || !conversationId || sending || !text.trim()) return;
  sending = true;
  setDot('busy');
  status('보내는 중…');
  try {
    await client.send({ type: 'message.send', conversationId, text });
    status('');
    inputEl.value = '';
    autoresize();
  } catch (error) {
    // The draft stays so the prompt is never silently dropped.
    setDot('error');
    status(error instanceof Error ? error.message : '보내지 못했습니다.');
    inputEl.value = text;
    autoresize();
  } finally {
    sending = false;
    render();
  }
}

function autoresize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 132)}px`;
}

async function poll() {
  if (document.hidden) return;
  try {
    if (!client) {
      // The first connect failed; retry the whole sequence instead of
      // staying dead until the desktop app restarts.
      await initialize();
      return;
    }
    await refresh();
    if (!sending) status(state?.runtime.ready === false ? `대화를 실행할 수 없습니다. ${state.runtime.detail}` : '');
  } catch (error) {
    setDot('error');
    status(error instanceof Error ? error.message : '연결을 확인해 주세요.');
  }
}

async function start() {
  try {
    await initialize();
  } catch (error) {
    setDot('error');
    status(error instanceof Error ? error.message : 'Ghost 호스트에 연결하지 못했습니다.');
  }
  // Self-scheduling: a slow round-trip must never overlap the next poll.
  const tick = () => {
    void poll().finally(() => setTimeout(tick, 1500));
  };
  setTimeout(tick, 1500);
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
