import { expect, it } from 'vitest';
import type { Profile } from '../client/types';
import { profileIsResponding, profilePetState } from './AvatarProvider';
const profile = (phase: string): Profile => ({ id: 'sage', name: 'Sage', persona: '', policy: {}, conversations: [{ id: 'conversation', title: '', model: 'mock', offline: true, messages: [{ role: 'assistant', text: '최근 완료 응답' }], tasks: [{ id: 'old', name: '응답 생성', phase: 'failed', output: '', partial: '' }, { id: 'current', name: '응답 생성', phase, output: '', partial: '' }] }] });
it('animates the default Ghost during model response only', () => {
  for (const phase of ['queued', 'model_ready', 'tools', 'tool_running', 'waiting_owner', 'complete', 'cancelled']) expect(profileIsResponding(profile(phase))).toBe(false);
  expect(profileIsResponding(profile('model_running'))).toBe(true);
});
it('does not let a historical failed task override a new response or completed conversation', () => {
  expect(profilePetState(profile('model_running'))).toBe('running');
  expect(profilePetState(profile('complete'))).toBe('idle');
  const failed = profile('failed'); failed.conversations[0].messages = [{ role: 'interrupted', text: '', task_id: 'current' }];
  expect(profilePetState(failed)).toBe('failed');
});
