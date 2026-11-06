import { afterEach, expect, it, vi } from 'vitest';
import type { ModelSettings, Snapshot } from '../client/types';
import { initialWorkspace } from '../fixtures/workspace';

// Exercise mounted hook state and asynchronous completions without a DOM,
// browser session, microphone, or network. React element rendering stays real.
const mounted = vi.hoisted(() => ({ current: null as any }));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original,
    useState: (initial: any) => {
      const host = mounted.current, index = host.index++;
      const slot = host.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, (next: any) => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; host.dirty = true; } }];
    },
    useRef: (initial: any) => { const host = mounted.current; return host.slots[host.index++] ??= { current: initial }; },
    useId: () => ':model-picker:',
    useEffect: (effect: () => void, dependencies: any[]) => {
      const host = mounted.current, index = host.index++, previous = host.slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) { host.effects.push(effect); host.slots[index] = { dependencies }; }
    },
  };
});
import { ConversationModelPicker } from './ConversationModelPicker';

const settings: ModelSettings = { version: 1, catalog_updated_ms: null, roles: { llm: 'local/a', stt: null, tts: null }, providers: [{ id: 'local', name: 'Local', kind: 'openai_compatible', endpoint: '', auth: { type: 'none' }, enabled: true, roles: ['llm'], models: ['a', 'b'].map(id => ({ id, name: id.toUpperCase(), roles: ['llm'] })), error: null, checked_ms: null }] };
afterEach(() => { mounted.current = null; });
function mount(snapshot: Snapshot, action: (command: any) => Promise<any>) {
  const props = { snapshot, profileId: snapshot.profiles[0].id, conversation: snapshot.profiles[0].conversations[0], busy: false, connected: true, mode: 'live', action, onCreated: vi.fn(), onSaving: vi.fn(), navigate: vi.fn(), running: false };
  const host = { slots: [] as any[], effects: [] as (() => void)[], index: 0, dirty: true, tree: null as any };
  const render = () => {
    mounted.current = host;
    let count = 0;
    do {
      if (++count > 20) throw new Error('Hook render did not settle');
      host.index = 0; host.dirty = false; host.tree = ConversationModelPicker(props);
      const effects = host.effects.splice(0); for (const effect of effects) effect();
    } while (host.dirty);
  };
  render();
  const field = () => host.tree.props.children[0] as { props: { children: (control: { id: string }) => { props: { onValueChange(value: string): void } }; description?: string } };
  const choose = (value: string) => { field().props.children({ id: 'model-select' }).props.onValueChange(value); render(); };
  return { props, host, render, choose, field };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it('serializes rapid changes and saves the latest queued choice after the first completion', async () => {
  const snapshot = initialWorkspace(); snapshot.model_settings = settings;
  snapshot.profiles[0].conversations[0].selected_model = 'local/a';
  let complete!: (value: any) => void;
  const action = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue({});
  const view = mount(snapshot, action);
  view.choose('local/b'); view.choose('local/a');
  expect(action).toHaveBeenCalledTimes(1);
  complete({}); await settle(); view.render(); await settle(); view.render();
  expect(action).toHaveBeenCalledTimes(2);
  expect(action.mock.calls[1][0].action.model).toBe('local/a');
});
it('pauses a queued model choice while disconnected and saves it only after reconnect', async () => {
  const snapshot = initialWorkspace(); snapshot.model_settings = settings;
  const action = vi.fn().mockResolvedValue({}), view = mount(snapshot, action);
  view.props.connected = false; view.render(); view.choose('local/b');
  expect(action).not.toHaveBeenCalled();
  view.props.connected = true; view.render(); await settle(); view.render();
  expect(action).toHaveBeenCalledTimes(1);
});
it('keeps creation identity stable through an early snapshot and remaps the later choice to the returned conversation', async () => {
  const snapshot = initialWorkspace(); snapshot.model_settings = settings; snapshot.profiles[0].conversations = [];
  let finishCreation!: (value: any) => void;
  const action = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishCreation = resolve; })).mockResolvedValue({});
  const view = mount(snapshot, action);
  view.props.onCreated.mockImplementation((id: string) => { view.props.conversation = snapshot.profiles[0].conversations.find(conversation => conversation.id === id)!; });
  view.choose('local/a'); view.choose('local/b');
  const created = { id: 'created', title: '새 대화', model: 'local/a', selected_model: 'local/a', offline: false, messages: [], tasks: [] };
  // useWorkspace may refresh before its action promise resolves. The parent
  // preserves its explicit empty selection until onCreated migrates the draft.
  snapshot.profiles[0].conversations.push(created); view.render();
  expect(view.props.conversation).toBeUndefined();
  finishCreation({ conversation_id: created.id }); await settle(); view.render(); await settle(); view.render();
  expect(view.props.onCreated).toHaveBeenCalledWith('created');
  expect(action.mock.calls[1][0]).toEqual({ type: 'workspace', action: { type: 'conversation_model', profile_id: view.props.profileId, conversation_id: 'created', model: 'local/b' } });
});

it('keeps the ordinary picker compact and identifies both models when a change awaits the next response', () => {
  const snapshot = initialWorkspace(); snapshot.model_settings = settings;
  Object.assign(snapshot.profiles[0].conversations[0], { model: 'local/a', selected_model: 'local/a', model_pending: false });
  const view = mount(snapshot, vi.fn().mockResolvedValue({}));
  expect(view.host.tree.props.children[1].props.children).toBeNull();
  expect(view.field().props.description).toContain('다음 응답부터');
  Object.assign(view.props.conversation, { selected_model: 'local/b', model_pending: true });
  view.props.running = true; view.render();
  expect(view.host.tree.props.children[1].props.children).toBe('현재: A · Local · 다음: B · Local');
});
