import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { inboxItems } from '../client/inbox';
import type { IntegrationApproval } from '../client/types';
import { InboxView } from '../features/WorkViews';
import { initialWorkspace } from '../fixtures/workspace';
import { inspectedIntegrationApproval, integrationReceipt } from './approvals';
import { ApprovalDrawerContent } from './ApprovalDrawer';
import { installedPlugins, pluginEnabled, reviewPlugin } from './registry';

const external: IntegrationApproval = {
  id: 'a-1',
  ghost_id: 'milo',
  conversation_id: 'pi-main',
  integration_id: 'outbox',
  integration_name: 'Fixture outbox',
  tool: 'send_fixture',
  state: 'pending',
  created_ms: 42,
};

it('requires the exact inspected external request and an object of arguments', () => {
  const valid = { ...external, arguments: { text: 'fixture' } };
  expect(inspectedIntegrationApproval(external, valid)).toEqual({ summary: external, arguments: valid.arguments, approvalAllowed: false });
  expect(inspectedIntegrationApproval(external, { ...valid, id: 'another-id' })).toBeUndefined();
  expect(inspectedIntegrationApproval(external, { ...valid, ghost_id: 'another-ghost' })).toBeUndefined();
  expect(inspectedIntegrationApproval(external, { ...valid, conversation_id: 'another-conversation' })).toBeUndefined();
  expect(inspectedIntegrationApproval(external, { ...valid, arguments: [] })).toBeUndefined();
  expect(integrationReceipt(external, { ...valid, state: 'uncertain' })).toEqual({ ...external, state: 'uncertain' });
  expect(integrationReceipt(external, { ...valid, state: 'unrecognized' })).toBeUndefined();
});

it('counts only pending decisions in the badge and keeps approval content out of the list', () => {
  const snapshot = initialWorkspace();
  snapshot.profiles.forEach(profile => profile.conversations.forEach(conversation => { conversation.tasks = []; }));
  snapshot.reviews[0].body = 'draft-body-fixture';
  snapshot.integrationApprovals = [
    { ...external, ...{ arguments: { text: 'external-arguments-fixture' } } },
    { ...external, id: 'running', state: 'dispatching' },
    { ...external, id: 'follow-up', state: 'uncertain' },
    { ...external, id: 'finished', state: 'sent' },
  ];
  const { approvalCount, count, groups } = inboxItems(snapshot);
  expect(approvalCount).toBe(2);
  expect(count).toBe(4);
  expect(groups.followup.map(item => item.id)).toEqual(['follow-up']);
  expect(groups.finished.map(item => item.id)).toEqual(['finished']);
  const html = renderToStaticMarkup(createElement(InboxView, { snapshot, navigate: () => {}, onOpenApproval: () => {} }));
  expect(html).toContain('결정 대기');
  expect(html).toContain('외부 결과 미확정');
  expect(html).toContain('처리 완료');
  expect(html).not.toContain('draft-body-fixture');
  expect(html).not.toContain('external-arguments-fixture');
  expect(html).not.toContain(external.tool);
  expect(html).not.toContain(external.id);
});

it('resolves a bundled renderer by capability and review kind for any Ghost ID', () => {
  const snapshot = initialWorkspace();
  const plugin = installedPlugins[1];
  expect(reviewPlugin('integration', snapshot, 'new-ghost', {})).toBeUndefined();
  snapshot.capabilities.integration_approvals = true;
  expect(reviewPlugin('integration', snapshot, 'new-ghost', {})).toBe(plugin);
  expect(reviewPlugin('integration', snapshot, 'new-ghost', { [plugin.id]: { enabled: false, version: plugin.version } })).toBeUndefined();
  expect(pluginEnabled(plugin, { [plugin.id]: { enabled: true, version: 0 } })).toBe(false);
  expect(pluginEnabled(plugin, { [plugin.id]: { enabled: true, version: plugin.version, definition: '4' } }, 5)).toBe(false);
});

it('falls back to metadata and the original conversation when the renderer is unavailable', () => {
  const snapshot = initialWorkspace();
  snapshot.integrationApprovals = [external];
  const html = renderToStaticMarkup(createElement(ApprovalDrawerContent, {
    snapshot, selected: { kind: 'integration', id: external.id },
    connected: true, busy: false, action: async () => ({}), query: async () => ({}),
    onClose: () => {}, onOpenConversation: () => {},
  }));
  expect(html).toContain(external.integration_name);
  expect(html).toContain('원래 대화');
  expect(html).not.toContain('승인하고 실행');
  expect(html).not.toContain(external.tool);
  expect(html).not.toContain(external.id);
});

it('presents a document request by title and content without showing its internal references', () => {
  const snapshot = initialWorkspace();
  snapshot.capabilities.documents = true;
  const review = snapshot.reviews[0];
  Object.assign(review, {
    title: '주간 회의 기록', body: '결정 사항을 공유합니다.',
    page_id: 'private-page-reference', space_id: 'private-space-reference',
    expected_hash: 'private-revision-reference',
  });
  const html = renderToStaticMarkup(createElement(ApprovalDrawerContent, {
    snapshot, selected: { kind: 'document', id: review.id },
    connected: true, busy: false, action: async () => ({}), query: async () => ({}),
    onClose: () => {}, onOpenConversation: () => {},
  }));
  expect(html).toContain('주간 회의 기록');
  expect(html).toContain('결정 사항을 공유합니다.');
  expect(html).toContain('기존 문서 수정');
  expect(html).not.toContain('private-');
});
