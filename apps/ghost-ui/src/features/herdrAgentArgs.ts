import type { HerdrAgentKind, OmpInfo } from '@ghost/contract';

export const approvals = ['always-ask', 'write', 'yolo'] as const;
export type Approval = typeof approvals[number];
export type AgentOptions = {
  conversation: 'new' | 'continue' | 'pick'; session: string; directory: string;
  model: string; thinking: string; approval: Approval | '';
};

export const defaultAgentOptions: AgentOptions = { conversation: 'new', session: '', directory: '', model: '', thinking: '', approval: '' };
const storageKey = 'ghost.coding.omp-options';

export function readOmpOptions(): AgentOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<AgentOptions> | null;
    if (saved) return {
      conversation: saved.conversation === 'pick' || saved.conversation === 'continue' ? saved.conversation : 'new',
      session: typeof saved.session === 'string' ? saved.session : '',
      directory: typeof saved.directory === 'string' ? saved.directory : '',
      model: typeof saved.model === 'string' ? saved.model : '',
      thinking: typeof saved.thinking === 'string' ? saved.thinking : '',
      approval: approvals.find(mode => mode === saved.approval) ?? '',
    };
  } catch { /* Storage can be unavailable. */ }
  return defaultAgentOptions;
}

export function rememberOmpOptions(options: AgentOptions) {
  try { localStorage.setItem(storageKey, JSON.stringify(options)); }
  catch { /* Storage can be unavailable. */ }
}

export function conversationForDirectory(options: AgentOptions, directory: string): AgentOptions['conversation'] {
  return options.conversation === 'pick' && options.directory !== directory ? 'new' : options.conversation;
}

/** Only emit session IDs and model-dependent levels offered by the corresponding Host lookup. */
export function buildAgentArgs(kind: HerdrAgentKind | undefined, options: AgentOptions, directory: string, info: OmpInfo | null, confirmedYolo = false): string[] {
  if (kind === 'claude') return options.conversation === 'continue' ? ['--continue'] : [];
  if (kind !== 'omp') return [];
  const args: string[] = [];
  const conversation = conversationForDirectory(options, directory);
  if (conversation === 'continue') args.push('--continue');
  if (conversation === 'pick' && info?.sessions.some(session => session.id === options.session)) args.push('--resume', options.session);
  const model = info?.models.find(item => item.selector === options.model);
  if (model) {
    args.push('--model', model.selector);
    if (model.thinking.includes(options.thinking)) args.push('--thinking', options.thinking);
  }
  if (options.approval && (options.approval !== 'yolo' || confirmedYolo)) args.push('--approval-mode', options.approval);
  return args;
}
