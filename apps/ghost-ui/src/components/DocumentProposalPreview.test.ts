import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DocumentProposalPreview } from './DocumentProposalPreview';

it('renders a proposed document as semantic Markdown without turning soft breaks into chat breaks', () => {
  const body = '# 검토안\n\n첫 문장\n이어지는 문장\n\n| 항목 | 판정 |\n| --- | --- |\n| 저장 | **보류** |\n\n- [x] 조사\n\n```ts\nconst value = 1;\n```';
  const markup = renderToStaticMarkup(createElement(DocumentProposalPreview, { body, profile: 'pdc-markdown/1' }));
  expect(markup).toContain('<h1>검토안</h1>');
  expect(markup).toContain('<table>');
  expect(markup).toContain('<strong>보류</strong>');
  expect(markup).toContain('첫 문장\n이어지는 문장');
  expect(markup).not.toContain('<br');
  expect(markup).toContain('const value = 1;');
});

it('keeps unknown profiles literal rather than interpreting their body as Markdown or HTML', () => {
  const body = '# Heading\n<script>alert(1)</script>';
  const markup = renderToStaticMarkup(createElement(DocumentProposalPreview, { body, profile: 'future/1' }));
  expect(markup).toContain('# Heading\n&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(markup).not.toContain('<h1>');
  expect(markup).not.toContain('<script>');
});
