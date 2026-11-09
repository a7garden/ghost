// Copyright (c) 2026 a7garden. MIT; see ../editor/LICENSE.
const SAFE_ELEMENTS = new Set([
  'html', 'head', 'body', 'title', 'main', 'article', 'section', 'header', 'footer', 'div', 'span',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'br', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img',
]);
const DROP_SUBTREE_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'textarea', 'select', 'option', 'optgroup', 'meta', 'link', 'base', 'svg', 'math',
  'video', 'audio', 'source', 'track', 'canvas', 'template', 'noscript',
]);
const SAFE_STYLE_PROPERTIES = new Set([
  'background-color', 'border-color', 'border-radius', 'border-style', 'border-width', 'color',
  'display', 'font-family', 'font-size', 'font-style', 'font-weight', 'list-style-type', 'margin',
  'margin-block', 'margin-inline', 'padding', 'padding-block', 'padding-inline', 'text-align',
  'text-decoration', 'white-space',
]);
const SAFE_COMMON_ATTRIBUTES = new Set(['aria-label', 'aria-hidden', 'class', 'dir', 'id', 'lang', 'title']);

function sanitizedStyle(styleText: string, element: HTMLElement): void {
  for (const declaration of styleText.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value || value.length > 160) continue;
    if (/(?:url\s*\(|expression\s*\(|@import|javascript:|vbscript:|data:|\/\*)/i.test(value)) continue;
    element.style.setProperty(property, value);
  }
}

function sanitizeNode(source: Node, parent: Node, document: Document): void {
  if (source.nodeType === 3) {
    parent.appendChild(document.createTextNode(source.nodeValue ?? ''));
    return;
  }
  if (source.nodeType !== 1) return;
  const sourceElement = source as Element;
  const tag = sourceElement.localName.toLowerCase();
  if (DROP_SUBTREE_ELEMENTS.has(tag)) return;
  if (!SAFE_ELEMENTS.has(tag)) {
    for (const child of Array.from(sourceElement.childNodes)) sanitizeNode(child, parent, document);
    return;
  }
  const element = document.createElement(tag);
  for (const attribute of Array.from(sourceElement.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name.startsWith('on') || name === 'srcdoc' || name === 'xmlns') continue;
    if (name === 'style') {
      sanitizedStyle(value, element);
    } else if (SAFE_COMMON_ATTRIBUTES.has(name)) {
      element.setAttribute(name, value);
    } else if ((tag === 'img' && name === 'alt') ||
      ((tag === 'img' || tag === 'th' || tag === 'td') && (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan')) ||
      (tag === 'th' && name === 'scope')) {
      if (/^(?:width|height|colspan|rowspan)$/.test(name) && !/^\d{1,4}$/.test(value)) continue;
      if (name === 'scope' && !/^(?:row|col|rowgroup|colgroup)$/.test(value)) continue;
      element.setAttribute(name, value);
    } else if (tag === 'ol' && name === 'start' && /^-?\d{1,6}$/.test(value)) {
      element.setAttribute(name, value);
    }
  }
  parent.appendChild(element);
  for (const child of Array.from(sourceElement.childNodes)) sanitizeNode(child, element, document);
}

/** Rebuilds inert HTML from an allowlist. The original source is never rewritten. */
export function sanitizeHtmlEmbed(source: string, ownerDocument: Document): DocumentFragment {
  const template = ownerDocument.createElement('template');
  template.innerHTML = source;
  const inertDocument = template.content.ownerDocument;
  const result = inertDocument.createDocumentFragment();
  for (const child of Array.from(template.content.childNodes)) sanitizeNode(child, result, inertDocument);
  return result;
}
