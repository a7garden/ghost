import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MessageBody } from './MessageBody';
import { splitRefs } from './refs';

const ID = '1adb45a3-1d86-815b-b3b7-506d74f7f64f';

it('takes an id out of prose, with its own parentheses but never a lone bracket', () => {
  expect(splitRefs(`상자 스크립트 (${ID}) — done`)).toEqual(['상자 스크립트 ', { kind: 'id', value: ID }, ' — done']);
  expect(splitRefs(`(see ${ID})`)).toEqual(['(see ', { kind: 'id', value: ID }, ')']);
  expect(splitRefs(`Work ${ID.toUpperCase()}이 완료`)).toEqual(['Work ', { kind: 'id', value: ID }, '이 완료']);
});

it('recognizes the shortened heads Ghosts write, but not hex-looking words', () => {
  expect(splitRefs('메인 (66eb43f1-…) — 입구, 작가 (01a1ba5c-5590-...) — 글')).toEqual([
    '메인 ', { kind: 'id', value: '66eb43f1' }, ' — 입구, 작가 ', { kind: 'id', value: '01a1ba5c-5590' }, ' — 글',
  ]);
  expect(splitRefs('deadbeef... and so on')).toEqual(['deadbeef... and so on']);
});

it('treats hex runs as digests only when they mix digits and letters', () => {
  expect(splitRefs('digest 60083fa5e45e, 4,667 bytes')).toEqual(['digest ', { kind: 'digest', value: '60083fa5e45e' }, ', 4,667 bytes']);
  // Timestamps, phone-like numbers and plain words stay text.
  expect(splitRefs('at 1731000000000 the decafbadcafe')).toEqual(['at 1731000000000 the decafbadcafe']);
  // Shorter than a digest prefix: a commit-like 7-character hash is not hidden.
  expect(splitRefs('commit 9cde8c9')).toEqual(['commit 9cde8c9']);
});

it('renders references in prose and bare code spans as marks, and leaves code blocks and links exact', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {
    text: `결과는 \`${ID}\`에 있고 (60083fa5e45e) 확인했습니다.\n\n\`\`\`\nid=${ID}\n\`\`\`\n\n[link ${ID}](https://example.com/${ID})`,
  }));
  const marks = html.match(/class="ref-mark"/g) ?? [];
  expect(marks).toHaveLength(2);
  expect(html).not.toContain('(60083fa5e45e)');
  expect(html).toContain(`id=${ID}`);
  expect(html).toContain(`>link ${ID}</a>`);
});
