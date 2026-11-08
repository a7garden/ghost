/**
 * Ghost's pet-linked conversation. A warm desktop webview into the selected
 * Ghost's existing direct conversation.
 */
import { HostClient } from '../host/client';
import type { Live, Message, State } from '@ghost/contract';
import { pickConversation, pickGhost, type Target } from './target';
import '../ui/styles.css';
import './overlay.css';
import { installWindowDrag } from '../host/windowDrag';
import { describeWake } from '../components/wake';

// The overlay follows the system theme independently of the main window.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', systemDark.matches);
applyTheme();
systemDark.addEventListener('change', applyTheme);

const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const logEl = document.getElementById('log') as HTMLOListElement;
const composerEl = document.getElementById('composer') as HTMLFormElement;
const titleEl = document.getElementById('title') as HTMLHeadingElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const activityEl = document.getElementById('activity') as HTMLSpanElement;
const statusEl = document.getElementById('status') as HTMLOutputElement;

const tauri = window.__TAURI_INTERNALS__;
if (tauri) installWindowDrag(command => tauri.invoke(command));

const client = new HostClient();
let state: State | null = null;
let ghostId = '';
let conversationId = '';
let messages: Message[] = [];
let live: Live | null = null;
let busy = false;
let sending = false;
let refreshing = false;
let refreshAgain = false;
let renderedSignature = '';
let connectionError = '';
let sendError = '';
let followLatest = true;
const targetKey = 'ghost-overlay:target';

function loadTarget(): Target {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(targetKey) || '{}');
    if (typeof raw !== 'object' || raw === null) return {};
    const ghostId = 'ghostId' in raw && typeof raw.ghostId === 'string' ? raw.ghostId : undefined;
    const conversationId = 'conversationId' in raw && typeof raw.conversationId === 'string' ? raw.conversationId : undefined;
    return { ghostId, conversationId };
  } catch { return {}; }
}

function escapeHtml(text: string) {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML;
}

function updateControls() {
  const target = loadTarget();
  const current = (!target.ghostId || target.ghostId === ghostId) &&
    (!target.conversationId || target.conversationId === conversationId);
  inputEl.disabled = sending || !conversationId || !current;
  sendEl.disabled = inputEl.disabled || !inputEl.value.trim() || !state?.runtime.ready || Boolean(connectionError);
  const error = sendError || connectionError || (state?.runtime.ready === false ? `대화를 실행할 수 없습니다. ${state.runtime.detail}` : '');
  statusEl.textContent = error;
  dotEl.className = error ? 'error' : busy || sending ? 'busy' : 'idle';
  activityEl.textContent = sending ? '보내는 중' : busy ? '응답 중' : '';
}

function render() {
  if (!state || !conversationId) return;
  const rows: string[] = [];
  for (const message of messages) {
    if (message.role === 'user' && message.text.trim()) {
      if (message.origin && message.origin !== 'owner') {
        const wake = describeWake(message.origin, message.text);
        rows.push(`<li class="row event">${escapeHtml(wake.label)} · ${escapeHtml(wake.line)}</li>`);
      } else rows.push(`<li class="row user"><div>${escapeHtml(message.text)}</div></li>`);
    } else if (message.role === 'assistant' && message.text.trim()) {
      rows.push(`<li class="row ghost"><div>${escapeHtml(message.text)}</div></li>`);
    }
  }
  if (busy) rows.push(live?.partial
    ? `<li class="row ghost"><div>${escapeHtml(live.partial)}</div></li>`
    : '<li class="row ghost working">생각하고 있어요<span aria-hidden="true">…</span></li>');
  const body = rows.length ? rows.join('') : '<li class="empty">무엇을 도와드릴까요?</li>';
  if (body !== renderedSignature) {
    renderedSignature = body;
    logEl.innerHTML = body;
    if (followLatest) logEl.scrollTop = logEl.scrollHeight;
  }
  const ghost = pickGhost(state, ghostId);
  titleEl.textContent = ghost?.name ?? 'Ghost';
  inputEl.placeholder = `${ghost?.name ?? 'Ghost'}에게 메시지`;
  updateControls();
}

/** Serialize snapshot reads; a target change supersedes the old response before paint. */
async function refresh(): Promise<void> {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const target = loadTarget();
  try {
    const next = await client.state();
    const ghost = pickGhost(next, target.ghostId);
    if (!ghost) throw new Error('등록된 Ghost가 없습니다.');
    const stored = pickConversation(next, ghost, target.conversationId);
    const page = await client.conversation(stored);
    const latest = loadTarget();
    if (latest.ghostId !== target.ghostId || latest.conversationId !== target.conversationId) {
      refreshAgain = true;
      return;
    }
    if (target.ghostId !== ghost.id || target.conversationId !== stored) {
      localStorage.setItem(targetKey, JSON.stringify({ ghostId: ghost.id, conversationId: stored }));
    }
    if (ghost.id !== ghostId || stored !== conversationId) {
      inputEl.value = '';
      sendError = '';
      followLatest = true;
      renderedSignature = '';
      autoresize();
    }
    ghostId = ghost.id;
    conversationId = stored;
    state = next;
    messages = page.messages;
    live = page.live;
    busy = page.conversation.busy;
    connectionError = '';
    render();
  } catch (error) {
    connectionError = error instanceof Error ? error.message : '호스트에 연결하지 못했습니다.';
  } finally {
    refreshing = false;
    updateControls();
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  }
}

async function send() {
  updateControls();
  const text = inputEl.value;
  if (sendEl.disabled || !text.trim()) return;
  const destination = conversationId;
  sending = true;
  sendError = '';
  updateControls();
  try {
    await client.send({ type: 'message.send', conversationId: destination, text });
    if (destination === conversationId) {
      inputEl.value = '';
      followLatest = true;
      autoresize();
    }
    await refresh();
  } catch (error) {
    if (destination === conversationId) sendError = error instanceof Error ? error.message : '보내지 못했습니다.';
  } finally {
    sending = false;
    updateControls();
    if (!inputEl.disabled) inputEl.focus();
  }
}

function autoresize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 100, innerHeight * .25)}px`;
}

function onTargetChange() {
  const target = loadTarget();
  if ((target.ghostId && target.ghostId !== ghostId) || (target.conversationId && target.conversationId !== conversationId)) {
    conversationId = '';
    inputEl.value = '';
    renderedSignature = '';
    logEl.replaceChildren();
    titleEl.textContent = state?.ghosts.find(ghost => ghost.id === target.ghostId)?.name ?? 'Ghost';
    autoresize();
  }
  updateControls();
  void refresh().then(() => { if (!inputEl.disabled) inputEl.focus(); });
}

composerEl.addEventListener('submit', event => { event.preventDefault(); void send(); });
inputEl.addEventListener('input', () => { sendError = ''; autoresize(); updateControls(); });
inputEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composerEl.requestSubmit();
  }
});
logEl.addEventListener('scroll', () => {
  followLatest = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
}, { passive: true });
const hide = () => {
  void tauri?.invoke('plugin:window|hide').catch(error => {
    connectionError = String(error); updateControls();
  });
};
document.getElementById('close')!.addEventListener('click', hide);
document.getElementById('open-main')!.addEventListener('click', () => {
  void tauri?.invoke('focus_main').catch(error => {
    connectionError = String(error); updateControls();
  });
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
window.addEventListener('focus', onTargetChange);
window.addEventListener('storage', event => { if (event.key === targetKey) onTargetChange(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) onTargetChange(); });
window.addEventListener('resize', autoresize);

void refresh();
const tick = () => {
  void (document.hidden ? Promise.resolve() : refresh()).finally(() => setTimeout(tick, 1000));
};
setTimeout(tick, 1000);
