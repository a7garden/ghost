import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { InlineText, MessageBody } from './MessageBody';
import { Transcript, TranscriptMessage } from './TranscriptMessage';

const render = (text: string) => renderToStaticMarkup(createElement(MessageBody, { text }));

it('keeps untrusted response HTML and unsafe links inert', () => {
  const html = render('<script>alert(1)</script>\n\n[run](javascript:alert%281%29)\n\n[encoded](jav&#x61;script:alert%281%29)\n\n[web](https://example.com)');
  expect(html).not.toMatch(/<script[\s>]/i);
  expect(html).not.toMatch(/href="javascript:/i);
  expect(html).toContain('href="https://example.com"');
});

it('does not request remote images embedded in assistant output', () => {
  const html = render('![private image](https://example.com/tracker.png)');
  expect(html).not.toMatch(/<img[\s>]/i);
  expect(html).not.toMatch(/<link[^>]+rel="preload"/i);
  expect(html).toContain('private image');
});

it('keeps the owner message literal instead of interpreting Markdown or HTML', () => {
  const html = renderToStaticMarkup(createElement(TranscriptMessage, {
    message: { id: 'm', conversationId: 'c', role: 'user', text: '**literal** <script>text</script>', origin: 'owner', toolCalls: [], tool: null, attachments: [], createdAt: 1 },
    speaker: () => '나',
  }));
  expect(html).toContain('**literal** &lt;script&gt;text&lt;/script&gt;');
  expect(html).not.toContain('<strong>');
});

it('shows project chips on the owner message without changing its text', () => {
  const html = renderToStaticMarkup(createElement(TranscriptMessage, {
    message: { id: 'm', conversationId: 'c', role: 'user', text: '계획을 알려줘', origin: 'owner', toolCalls: [], tool: null, attachments: [], spaces: [{ id: 'project', name: '비행 <기록>' }], createdAt: 1 },
    speaker: () => '나',
  }));
  expect(html).toContain('계획을 알려줘');
  expect(html).toContain('href="#/spaces/project"');
  expect(html).toContain('비행 &lt;기록&gt;');
  expect(html).not.toContain('document_list');
});

it('marks only the owner turn that replaced its outgoing row, so it does not rise in a second time', () => {
  const owner = (id: string, text: string) => ({ id, conversationId: 'c', role: 'user' as const, text, origin: 'owner' as const, toolCalls: [], tool: null, attachments: [], createdAt: 1 });
  const html = renderToStaticMarkup(createElement(Transcript, {
    messages: [owner('m1', '어제 보낸 말'), owner('m2', '방금 보낸 말')], speaker: () => '나', delivered: new Set(['m2']),
  }));
  expect(html.match(/data-delivered/g)).toHaveLength(1);
  expect(html.indexOf('data-delivered')).toBeGreaterThan(html.indexOf('어제 보낸 말'));
});

it('preserves a linked image destination without nesting anchors or loading the image', () => {
  const html = render('[![build](https://example.com/badge.svg)](https://example.com/build)');
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).toContain('href="https://example.com/build"');
  expect(html).not.toContain('<img');
});

it('keeps footnote targets and references available without exposing relative app routes', () => {
  const html = render('A note[^1].\n\n[^1]: Footnote\n\n[relative](docs/a.md)');
  expect(html).toContain('id="user-content-fnref-1"');
  expect(html).toContain('href="#user-content-fn-1"');
  expect(html).toContain('id="user-content-fn-1"');
  expect(html).not.toContain('target="_blank"');
  expect(html).not.toContain('href="docs/a.md"');
});

it('streams words as their own nodes, keeps code exact and puts the caret after the newest word', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, { text: '목록:\n\n- 첫 항목\n- 둘째 **굵게** 끝\n\n```\nconst a = 1;\n```\n\n마지막 문장', streaming: true }));
  expect(html).toContain('<span class="stream-word">첫</span> <span class="stream-word">항목</span>');
  expect(html).toContain('<code>const a = 1;\n</code>');
  expect(html.match(/stream-caret/g)).toHaveLength(1);
  expect(html).toMatch(/<span class="stream-word">문장<\/span><span class="stream-caret" aria-hidden="true"><\/span><\/p><\/div>$/);
  const settled = render('마지막 문장');
  expect(settled).not.toContain('stream-');
});

it('bolds Korean text wrapped around brackets, where CommonMark alone leaves the asterisks', () => {
  const html = render('발주처는 **「산림청」**이고 기한은 **11월 말**까지입니다.');
  expect(html).toContain('<strong>「산림청」</strong>이고');
  expect(html).toContain('<strong>11월 말</strong>까지');
  expect(html).not.toContain('**');
});

it('keeps the single line breaks a Ghost writes in messages, but not in stored documents', () => {
  expect(render('할 일\n두 항목만 다시 확인한다.')).toMatch(/할 일<br\/?>\s*두 항목/);
  const document = renderToStaticMarkup(createElement(MessageBody, { text: '할 일\n두 항목', document: true }));
  expect(document).not.toContain('<br');
});

it('draws task-list results as state shapes, not form checkboxes', () => {
  const html = render('- [x] **확인 1** 추가 줄 있음\n- [ ] **확인 2** 출력이 잘림');
  expect(html).not.toMatch(/<input/);
  expect(html).toContain('aria-label="확인됨"');
  expect(html).toContain('aria-label="확인 안 됨"');
  expect(html).toContain('data-state="done"');
});

it('gives a one-line command its copy action without a language bar', () => {
  const single = render('```bash\ngit show eee86ea1\n```');
  expect(single).toContain('data-single');
  expect(single).not.toContain('message-body__code-bar');
  expect(single).toContain('git show eee86ea1');
  const multi = render('```bash\ngit log\ngit status\n```');
  expect(multi).toContain('message-body__code-bar');
});

it('renders a one-line slot inline: emphasis and code, no blocks, no glued words', () => {
  const html = renderToStaticMarkup(createElement(InlineText, { text: '발주처 **「산림청」**이 `svn` 을\n\n막았습니다' }));
  expect(html).toContain('<strong>「산림청」</strong>이');
  expect(html).toContain('<code>svn</code>');
  expect(html).not.toMatch(/<p|<br/);
  expect(html).toContain('을 막았습니다');
});

it('wraps a one-line slot so a 200-character URL breaks inside it instead of widening its row', () => {
  const url = `https://example.com/${'a'.repeat(200)}`;
  const html = renderToStaticMarkup(createElement(InlineText, { text: `실패: ${url}` }));
  expect(html).toMatch(/^<span class="message-body__inline">/);
  expect(html).toContain(url);
});

it('gives every cell of a twelve-column table its column name, so a phone can lay rows out as cards', () => {
  const head = Array.from({ length: 12 }, (_, index) => `열${index + 1}`);
  const html = render(`| ${head.join(' | ')} |\n|${' --- |'.repeat(12)}\n| ${head.map((_, index) => index === 0 ? '**가**' : `값${index + 1}`).join(' | ')} |`);
  expect(html).toContain('<table data-wide="" role="table">');
  expect(html).toContain('<th role="columnheader">열12</th>');
  expect(html).toContain('<td role="cell" data-label="열1"><div class="message-body__cell"><strong>가</strong></div></td>');
  expect(html).toContain('<td role="cell" data-label="열12"><div class="message-body__cell">값12</div></td>');
});

it('leaves a narrow table a plain table that wraps in place', () => {
  const html = render('| 이름 | 주소 |\n| --- | --- |\n| 문서 | https://example.com/path |');
  expect(html).toContain('<table>');
  expect(html).not.toContain('data-label');
});
