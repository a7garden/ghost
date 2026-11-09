import { describe, expect, it } from 'vitest';
import { staticHtmlPreviewHeight } from './StaticHtmlBlock';

describe('static HTML preview sizing', () => {
  it.each([
    '<style>article { min-height: 600px; }</style><article>보고서</article>',
    '<STYLE media="screen">p { padding: 100px; }</STYLE><p>기록</p>',
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="자료">',
    '<img/>',
  ])('keeps a comfortable scrollable frame for styles or images: %s', html => {
    expect(staticHtmlPreviewHeight(html)).toBe(380);
  });

  it.each([
    '<article><h2>보고서</h2><p>읽을 내용</p></article>',
    '<p style="font-size:24px">본문</p>',
    '<p>&lt;style&gt;와 &lt;img&gt;는 여기서 텍스트입니다.</p>',
  ])('continues measuring ordinary sanitized markup: %s', html => {
    expect(staticHtmlPreviewHeight(html)).toBeUndefined();
  });
});
