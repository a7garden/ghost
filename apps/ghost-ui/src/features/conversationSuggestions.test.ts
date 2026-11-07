import { expect, it } from 'vitest';
import { conversationSuggestions } from './conversationSuggestions';

it('uses the role introduction for planning and editing examples', () => {
  expect(conversationSuggestions('계획과 작은 할 일을 놓치지 않게 챙기는 파트너').join(' ')).toContain('맡긴 일의 진행 상황');
  expect(conversationSuggestions('복잡한 생각을 읽기 좋은 글로 다듬는 에디터').join(' ')).toContain('문장을 다듬어');
});

it('falls back when a custom role is unknown or covers multiple roles', () => {
  const fallback = conversationSuggestions('');
  expect(conversationSuggestions('수학 튜터')).toEqual(fallback);
  expect(conversationSuggestions('개발자이자 에디터')).toEqual(fallback);
});

it('does not infer a role from tool identifiers or later model instructions', () => {
  const fallback = conversationSuggestions('');
  expect(conversationSuggestions('research_assistant 도구를 관리합니다.')).toEqual(fallback);
  expect(conversationSuggestions('요청 범위를 함께 정하는 비서\n개발자에게 작업을 위임합니다.')).toEqual(fallback);
});

it('supports English role names without classifying unrelated word fragments', () => {
  expect(conversationSuggestions('A software engineer').join(' ')).toContain('오류 메시지');
  expect(conversationSuggestions('주간 계획과 플래너를 관리합니다').join(' ')).toContain('맡긴 일의 진행 상황');
  expect(conversationSuggestions('An editorial historian')).toEqual(conversationSuggestions(''));
});
