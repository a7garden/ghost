import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { GardenMarkdownPreview } from './GardenMarkdownPreview';

function render(theme: 'light' | 'dark') {
  return renderToStaticMarkup(createElement(GardenMarkdownPreview, {
    html: '<p>주간 기록</p>', title: '주간 기록', theme,
  }));
}

it('keeps the document preview in a locked frame', () => {
  const html = render('light');
  expect(html).toContain('sandbox=""');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain('title="주간 기록 미리보기"');
});
