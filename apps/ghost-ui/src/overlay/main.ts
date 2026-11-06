/**
 * Ghost chat overlay. Lives in the desktop app's second webview: a small
 * always-on-top window the native side parks off-screen and surfaces over the
 * current work. Same console origin, so the bridge CSRF, routing contract and
 * pending-turn journal are identical to the main console. Showing/hiding is
 * native (src-tauri main.rs: ⌘⇧G toggle, focus-loss hide); Esc hide is handled
 * locally below via the plugin:window|hide IPC.
 */
import { CommandQueue, connect, RoutingPending, RoutingTerminal } from '../client/api';
import { RoutingClient } from '../client/routingClient';
import { isRunning, phaseLabel, type Client, type Profile, type Snapshot } from '../client/types';
import type { RoutingTurn } from '../client/routingTypes';
import { legacySubmitKind, pickConversation, pickProfile, routingKind, type Target } from './target';
import '@garden/ui/styles.css';
import './overlay.css';

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
// the window hide command that the capability grants.
interface TauriInternals {
  invoke(command: string): Promise<void>;
}
const tauri = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

let client: Client | null = null;
let routing: RoutingClient | null = null;
let queue: CommandQueue | null = null;
let queueWorkspace = '';
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

function currentConversation(snapshot: Snapshot | null) {
  return snapshot?.profiles
    .find(p => p.id === profile?.id)
    ?.conversations.find(c => c.id === conversationId);
}

async function initialize(): Promise<void> {
  client = await connect();
  const snapshot = await client.snapshot();
  lastSnapshot = snapshot;
  adoptWorkspace(snapshot);
  await ensureConversation(snapshot);
  render();
  setDot('idle');
}

/** The console rebuilds its journal queue per workspace; the overlay does too. */
function adoptWorkspace(snapshot: Snapshot) {
  workspaceId = snapshot.workspace_id;
  target = loadTarget(workspaceId);
  if (queueWorkspace !== workspaceId) {
    queueWorkspace = workspaceId;
    queue = new CommandQueue(localStorage, `ghost-overlay:pending:${workspaceId}`);
    routing = client?.routing?.canPrepareInput
      ? new RoutingClient(client.routing, queue)
      : null;
  }
}

async function ensureConversation(snapshot: Snapshot): Promise<void> {
  const next = pickProfile(snapshot, target.profile_id);
  if (!next) {
    status('등록된 Ghost가 없습니다.');
    return;
  }
  let changed = false;
  if (next.id !== profile?.id) {
    profile = next;
    changed = true;
  }
  const found = pickConversation(next, target.conversation_id);
  if (found !== conversationId) {
    conversationId = found;
    changed = true;
  }
  if (!conversationId) {
    // Journaled dispatch like useWorkspace.action: a lost reply retries with
    // the same request id instead of minting duplicate conversations.
    const result: unknown = await queue!.send(client!, {
      type: 'create_conversation',
      profile_id: profile.id,
      model: snapshot.default_model,
      tools: true,
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

// Element-content interpolation only: textContent round-trip does not escape
// quotes, so never reuse this for an attribute value.
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
  const tasks = conversation?.tasks ?? [];
  const running = tasks.filter(t => isRunning(t.phase)).at(-1);
  if (running) {
    const partial = running.partial.trim() || `${phaseLabel(running.phase)}…`;
    rows.push(`<li class="row ghost working"><div>${escapeHtml(partial)}</div></li>`);
  } else {
    // A turn that ended without a reply (failed/cancelled classification) must
    // not look like a silently dropped message.
    const last = tasks.at(-1);
    const lastUserIndex = (conversation?.messages ?? []).map(m => m.role).lastIndexOf('user');
    const answered = (conversation?.messages ?? []).some(
      (m, index) =>
        index > lastUserIndex && m.role === 'assistant' && m.text.trim(),
    );
    if (last && ['failed', 'cancelled'].includes(last.phase) && !answered) {
      const note = last.output.trim() || phaseLabel(last.phase);
      rows.push(`<li class="row ghost working"><div>${escapeHtml(note)}</div></li>`);
    }
  }
  const body = rows.length
    ? rows.join('')
    : '<li class="empty">주 Ghost와의 대화가 여기에 표시됩니다.</li>';
  // Working rows re-render freely; settled rows only when the body changes.
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
  if (!client || !queue || !profile || !conversationId || sending || !text.trim()) return;
  sending = true;
  setDot('busy');
  status('보내는 중…');
  const conversation = currentConversation(lastSnapshot);
  const running = (conversation?.tasks ?? []).filter(t => isRunning(t.phase)).length;
  try {
    if (routing && client.routing?.canPrepareInput) {
      const turn: RoutingTurn = {
        entry: { entry_profile_id: profile.id, conversation_id: conversationId },
        text,
        kind: routingKind(conversation?.messages.length ?? 0),
        resolves: [],
      };
      await routing.submit(turn);
    } else {
      await queue!.send(client, {
        type: 'submit',
        profile_id: profile.id,
        conversation_id: conversationId,
        prompt: text,
        kind: legacySubmitKind(running),
      });
    }
    status('');
  } catch (error) {
    // Direct-answer turns end without an admission and the reply still lands
    // through snapshot polling (the console clears these too). Unexpected
    // failures restore the draft instead of silently dropping the prompt.
    if (!(error instanceof RoutingPending) && !(error instanceof RoutingTerminal)) {
      setDot('error');
      status(error instanceof Error ? error.message : '보내지 못했습니다.');
      inputEl.value = text;
      autoresize();
    } else {
      status('');
    }
  } finally {
    sending = false;
    render();
  }
}

async function poll() {
  if (document.hidden) return;
  try {
    if (!client) {
      // The first connect failed; retry the whole sequence instead of
      // staying dead until the console restarts.
      await initialize();
      return;
    }
    const snapshot = await client.snapshot();
    lastSnapshot = snapshot;
    adoptWorkspace(snapshot);
    await ensureConversation(snapshot);
    render();
    if (!sending) status('');
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
    await initialize();
  } catch (error) {
    setDot('error');
    status(error instanceof Error ? error.message : 'Ghost 호스트에 연결하지 못했습니다.');
  }
  // Self-scheduling like the console: a slow round-trip must never overlap
  // the next poll (two overlapping ensureConversation calls would each
  // create a conversation).
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
