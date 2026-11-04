import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from './normalize';

const snapshot = { workspace_id: 'fixture', profiles: [] };

describe('normalizeSnapshot integration approvals', () => {
  it('keeps legacy, blocked, and selected tool access distinct', () => {
    const normalized = normalizeSnapshot({
      ...snapshot,
      integrations: [
        { id: 'legacy' },
        { id: 'legacy-null', approved_tools: null },
        { id: 'blocked', approved_tools: [] },
        { id: 'selected', approved_tools: ['send_gmail_message'] },
      ],
    });
    expect(normalized.integrations.map(item => item.approved_tools)).toEqual([
      undefined, null, [], ['send_gmail_message'],
    ]);
    expect(normalized.integrationApprovals).toBeUndefined();
  });

  it('accepts valid approval summaries and projects only public fields', () => {
    const approval = {
      id: 'approval', ghost_id: 'ghost', conversation_id: 'conversation',
      integration_id: 'gmail', integration_name: 'Gmail', tool: 'send_gmail_message',
      state: 'pending', created_ms: 1,
    };
    const normalized = normalizeSnapshot({
      ...snapshot,
      capabilities: { integration_approvals: true },
      integration_approvals: [
        { ...approval, arguments: { subject: 'fixture only' } },
        { ...approval, state: 'unknown' },
        { ...approval, created_ms: null },
      ],
    });
    expect(normalized.capabilities.integration_approvals).toBe(true);
    expect(normalized.integrationApprovals).toEqual([approval]);
  });
});
