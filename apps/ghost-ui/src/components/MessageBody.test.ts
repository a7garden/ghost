import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { MessageBody } from './MessageBody';
import { TranscriptMessage } from './TranscriptMessage';

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
