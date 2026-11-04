import { useSyncExternalStore } from 'react';
import type { Snapshot } from '../client/types';
import type { ApprovalKind } from './approvals';

interface PluginManifest {
  id: string;
  version: number;
  label: string;
  reviewKind: ApprovalKind;
  capability: string;
  agentPanel: string;
}

export const installedPlugins = [
  { id: 'document-review', version: 1, label: '문서 검토', reviewKind: 'document', capability: 'documents', agentPanel: '문서 저장' },
  { id: 'integration-review', version: 1, label: '외부 연동 검토', reviewKind: 'integration', capability: 'integration_approvals', agentPanel: '외부 실행' },
] as const satisfies readonly PluginManifest[];

export type InstalledPlugin = typeof installedPlugins[number];
type Binding = { version: number; enabled: boolean; definition?: string };
type Bindings = Record<string, Binding>;

function preferenceKey(workspaceKey: string, ghostId: string) {
  return `ghost-ui:plugin-surfaces:v1:${encodeURIComponent(workspaceKey)}:${encodeURIComponent(ghostId)}`;
}

function readPreferences(key: string) {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

const getServerPreferences = () => '';

export function usePluginPreferences(workspaceKey: string, ghostId: string) {
  const key = preferenceKey(workspaceKey, ghostId);
  const value = useSyncExternalStore(listener => {
    window.addEventListener(key, listener);
    window.addEventListener('storage', listener);
    return () => {
      window.removeEventListener(key, listener);
      window.removeEventListener('storage', listener);
    };
  }, () => readPreferences(key), getServerPreferences);
  return {
    bindings: parseBindings(value),
    setEnabled(plugin: InstalledPlugin, enabled: boolean, definitionVersion?: string | number) {
      const bindings = parseBindings(readPreferences(key));
      bindings[plugin.id] = {
        version: plugin.version, enabled,
        ...(definitionVersion === undefined ? {} : { definition: String(definitionVersion) }),
      };
      window.localStorage.setItem(key, JSON.stringify(bindings));
      window.dispatchEvent(new Event(key));
    },
  };
}

function parseBindings(value: string): Bindings {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Bindings;
  } catch { /* missing or invalid preferences */ }
  return {};
}

export function pluginAvailable(plugin: InstalledPlugin, snapshot: Snapshot, ghostId: string) {
  const capability = snapshot.capabilities[plugin.capability];
  // Older workspace fixtures do not advertise documents; a proposal is
  // sufficient to display their existing review surface.
  return capability === true || (plugin.reviewKind === 'document' && capability === undefined
    && snapshot.reviews.some(review => review.profile_id === ghostId));
}

export function pluginEnabled(plugin: InstalledPlugin, bindings: Bindings, definitionVersion?: string | number) {
  const binding = bindings[plugin.id];
  if (binding === undefined) return true;
  if (binding?.version !== plugin.version) return false;
  if (definitionVersion !== undefined && binding.definition !== undefined
    && binding.definition !== String(definitionVersion)) return false;
  return binding.enabled === true;
}

export function reviewPlugin(kind: ApprovalKind, snapshot: Snapshot, ghostId: string, bindings: Bindings) {
  return installedPlugins.find(plugin => plugin.reviewKind === kind && pluginAvailable(plugin, snapshot, ghostId)
    && pluginEnabled(plugin, bindings));
}
