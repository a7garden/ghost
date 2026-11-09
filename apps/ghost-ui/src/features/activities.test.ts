import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BROWSER_TOOLS, GHOST_TOOLS, HOST_TOOLS, VAULT_TOOLS, type ActivityConfig, type ActivityRun, type ActivitySource, type Ghost } from '@ghost/contract';
import { activityToolChoices, buildActivityConfig, draftFromConfig, emptyDraft, intersectTools, type ActivityDraft } from './activity-config';
import { RunRow } from './Activities';

const ghost = (patch: Partial<Ghost> = {}): Ghost => ({
  id: 'g1', name: '연구원', persona: '', look: { avatarId: null }, model: null, isDefault: false, state: 'active',
  tools: ['read', 'web_search', 'web_read', 'memory_search', 'document_read', 'bash', 'write'], fallbacks: [], skills: [],
  deletedAt: null, directConversationId: 'conv-g1', createdAt: 1, updatedAt: 1, ...patch,
});

const draft = (patch: Partial<ActivityDraft> = {}): ActivityDraft => ({
  ...emptyDraft(ghost()),
  name: '메일 정리', prompt: '새 메일을 살펴보고 요약해 줘.', acceptanceCriteria: '요약이 매 실행 끝에 남는다.',
  ...patch,
});

it('offers the activity no tool the Ghost itself does not have', () => {
  const allowed = ['web_search', 'read'];
  const narrowed = intersectTools(['bash', 'web_search', 'ghost_list', 'web_search'], allowed);
  expect(narrowed.every(tool => allowed.includes(tool))).toBe(true);
  expect(narrowed).toEqual(['web_search']);
});

it('matches selectable Work extensions, retaining documents, browser and vault without direct-only proposals', () => {
  const choices = activityToolChoices(GHOST_TOOLS);
  expect(choices).toEqual([
    'read', 'write', 'edit', 'bash', 'publish_artifact', 'delegate',
    'memory_search', 'memory_recall', 'memory_retain',
    'document_spaces', 'document_list', 'document_read',
    'web_search', 'web_read', 'reach', 'skill_read',
    ...HOST_TOOLS, ...BROWSER_TOOLS, ...VAULT_TOOLS,
  ]);
  expect(intersectTools(['activity_propose', 'document_read', 'browser_open', 'vault_list'], GHOST_TOOLS))
    .toEqual(['document_read', 'browser_open', 'vault_list']);
});

it('keeps skipped reasons, exact run timestamps and self-check explanations in history', () => {
  const run: ActivityRun = {
    id: 'run1', activityId: 'a1', workId: null, trigger: 'source', sourceKey: 'oversized-mail',
    sourceItem: null, state: 'skipped', activityRevision: 1, reason: '메일이 크기 제한을 넘었습니다.',
    dryRun: false, noChange: false, createdAt: 2_000_000_012_345, endedAt: 2_000_000_012_345,
    nextCheckAt: 2_000_000_102_345, nextCheckReason: '새 항목을 다시 확인합니다.', followupOf: null,
  };
  const markup = renderToStaticMarkup(createElement(RunRow, { run, now: run.createdAt, navigate: () => {} }));
  expect(markup).toContain('건너뜀');
  expect(markup).toContain(run.reason);
  expect(markup).toContain(new Date(run.createdAt).toISOString());
  expect(markup).toContain(run.nextCheckReason);
  expect(markup).not.toContain('맡긴 일 열기');
  expect(markup).not.toContain('변경 없음');
});

it('refuses host execution without the owner grant or an absolute folder', () => {
  const ungranted = buildActivityConfig(draft({ executionKind: 'host', hostCwd: '/tmp/x' }), ghost());
  expect(ungranted).toMatchObject({ ok: false });
  const granted = buildActivityConfig(draft({ executionKind: 'host', hostCwd: '/tmp/x' }), ghost({ hostExecution: true }));
  expect(granted).toMatchObject({ ok: true, config: { execution: { kind: 'host', cwd: '/tmp/x' } } });
  const relative = buildActivityConfig(draft({ executionKind: 'host', hostCwd: 'tmp/x' }), ghost({ hostExecution: true }));
  expect(relative).toMatchObject({ ok: false });
});

it('rejects malformed source filters and out-of-bound limits before anything reaches the host', () => {
  expect(buildActivityConfig(draft({ sourceKind: 'pull_request', connectionId: 'conn1', repository: 'ghost' }), ghost()))
    .toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ sourceKind: 'pull_request', connectionId: 'conn1', repository: 'garden/ghost' }), ghost()))
    .toMatchObject({ ok: true });
  expect(buildActivityConfig(draft({ sourceKind: 'mail', connectionId: '' }), ghost())).toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ sourceKind: 'mail', connectionId: 'conn2', pollMinutes: '20000' }), ghost()))
    .toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ maxConcurrent: '9' }), ghost())).toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ maxRunsPerDay: '0' }), ghost())).toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ name: '' }), ghost())).toMatchObject({ ok: false });
  expect(buildActivityConfig(draft({ acceptanceCriteria: '' }), ghost())).toMatchObject({ ok: false });
});

it.each<ActivitySource>([
  { kind: 'pull_request', connectionId: 'c1', repository: 'garden/ghost', baseBranch: 'release',
    labels: ['review'], includeDrafts: true, includeExisting: false, pollSeconds: 90 },
  { kind: 'mail', connectionId: 'c2', sender: 'owner@example.com', subjectContains: 'Review',
    unreadOnly: false, includeExisting: false, pollSeconds: 61 },
])('renaming a source activity leaves its cursor authority and precise limits unchanged: $kind', source => {
  const original = buildActivityConfig(draft(), ghost());
  if (!original.ok) throw new Error(original.error);
  const config: ActivityConfig = {
    ...original.config, source,
    policy: { ...original.config.policy, runTimeoutSeconds: 45, minCheckSeconds: 91, allowSelfCheck: true },
  };
  const edited = draftFromConfig(config);
  edited.name = 'Renamed only';
  const saved = buildActivityConfig(edited, ghost());
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error);
  // Host uses source equality to retain its already-consumed source cursor.
  expect(saved.config.source).toEqual(config.source);
  expect(saved.config.policy).toEqual(config.policy);
  expect(saved.config).toEqual({ ...config, name: 'Renamed only' });
});

it.each([
  { kind: 'every' as const, seconds: 7 * 86400 + 1, startAt: 2_000_000_012_345 },
  { kind: 'at' as const, at: 2_000_000_012_345 },
])('renaming a scheduled activity does not move its next occurrence: $kind', spec => {
  const original = buildActivityConfig(draft(), ghost());
  if (!original.ok) throw new Error(original.error);
  const config: ActivityConfig = { ...original.config, source: { kind: 'schedule', spec } };
  const edited = draftFromConfig(config);
  edited.name = 'Renamed schedule';
  const saved = buildActivityConfig(edited, ghost());
  expect(saved).toEqual({ ok: true, config: { ...config, name: 'Renamed schedule' } });
});

it('accepts whole-second durations but refuses contract limit violations and subsecond intervals', () => {
  const valid = buildActivityConfig(draft({
    everyMinutes: '10080', pollMinutes: '1.5', runTimeoutMinutes: '0.5', minCheckMinutes: '1.5',
  }), ghost());
  expect(valid).toMatchObject({ ok: true, config: {
    source: { kind: 'schedule', spec: { seconds: 604800 } },
    policy: { runTimeoutSeconds: 30, minCheckSeconds: 90 },
  } });
  for (const patch of [
    { everyMinutes: '0.5' }, { everyMinutes: '1.001' }, { runTimeoutMinutes: '0.49' },
    { runTimeoutMinutes: '1440.1' }, { minCheckMinutes: '0.5' },
    { sourceKind: 'mail' as const, connectionId: 'c1', pollMinutes: '1440.1' },
  ]) expect(buildActivityConfig(draft(patch), ghost())).toMatchObject({ ok: false });
});
