import { useId, useMemo, useState } from 'react';
import createDOMPurify from 'dompurify';
import { SegmentedControl } from '../../ui';

const tags = ['div', 'span', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'mark', 'blockquote', 'pre', 'code', 'kbd', 'samp', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'details', 'summary', 'style', 'img'];
const attributes = ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'colspan', 'rowspan', 'scope', 'headers', 'span', 'start', 'reversed', 'type', 'open', 'src', 'alt', 'width', 'height'];
const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";

/** Sanitized static markup only. The separate opaque-origin frame has no bridge to Ghost. */
export function staticHtmlDocument(source: string): string {
  const purifier = createDOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, attribute) => {
    if (attribute.attrName === 'src') {
      attribute.keepAttr = node.nodeName === 'IMG' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(attribute.attrValue);
    }
  });
  const html = purifier.sanitize(source, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: attributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: null, attributeNameCheck: null, allowCustomizedBuiltInElements: false },
    FORCE_BODY: true,
    FORBID_TAGS: ['script', 'form', 'input', 'button', 'textarea', 'select', 'option', 'meta', 'base', 'link', 'a', 'iframe', 'object', 'embed', 'svg', 'math'],
    FORBID_ATTR: ['href', 'srcset', 'action', 'formaction', 'target', 'download', 'ping', 'is', 'autofocus', 'contenteditable', 'tabindex'],
  });
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{margin:16px;font:14px/1.6 system-ui,sans-serif;color:#1a1c1f;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}th,td{padding:6px 10px;border:1px solid #ddd}pre{overflow:auto}*{box-sizing:border-box}</style></head><body>${html}</body></html>`;
}

export function StaticHtmlBlock({ title, html }: { title: string; html: string }) {
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const titleId = useId();
  const document = useMemo(() => staticHtmlDocument(html), [html]);
  return <section className="ghost-ui-block" aria-labelledby={titleId}>
    <div className="ghost-ui-block__bar"><h3 id={titleId}>{title}</h3>
      <SegmentedControl aria-label={`${title} 보기`} value={view} onValueChange={setView} options={[{ value: 'preview', label: '미리보기' }, { value: 'source', label: '소스' }]}/>
    </div>
    {view === 'preview'
      ? <iframe className="ghost-ui-html" title={`${title} · 정적 HTML 미리보기`} sandbox="" referrerPolicy="no-referrer" srcDoc={document}/>
      : <pre className="ghost-ui-source" tabIndex={0}>{html}</pre>}
  </section>;
}
