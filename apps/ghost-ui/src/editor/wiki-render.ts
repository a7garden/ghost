// Copyright (c) 2026 a7garden. MIT; see LICENSE.
import { render as renderKatex } from 'katex';
import { parseWikiTarget } from './syntax.js';

function innerMathSource(nodeName: string, raw: string): string {
  if (nodeName === 'GhostMathInline') {
    return raw.length >= 2 && raw.startsWith('$') && raw.endsWith('$') ? raw.slice(1, -1) : raw;
  }
  if (nodeName !== 'GhostMathBlock' || raw.length < 4 || !raw.startsWith('$$') || !raw.endsWith('$$')) return raw;
  let source = raw.slice(2, -2);
  source = source.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return source;
}

/** Renders only parser-owned math source through KaTeX's non-trusting DOM API. */
export function renderWikiMath(document: Document, source: string, displayMode: boolean): HTMLElement {
  const element = document.createElement(displayMode ? 'div' : 'span');
  element.className = `ghost-wiki-math ${displayMode ? 'ghost-wiki-math-block' : 'ghost-wiki-math-inline'}`;
  try {
    renderKatex(source, element, {
      displayMode,
      trust: false,
      strict: 'warn',
      maxExpand: 1000,
      maxSize: 20,
      throwOnError: false,
      output: 'htmlAndMathml',
    });
    if (element.querySelector('.katex-error')) {
      element.replaceChildren(document.createTextNode(source));
      element.dataset.mathError = 'true';
    }
  } catch {
    element.replaceChildren(document.createTextNode(source));
    element.dataset.mathError = 'true';
  }
  return element;
}

function calloutType(raw: string): string | null {
  const match = /^\[!([A-Za-z][A-Za-z0-9_-]*)\]$/.exec(raw);
  return match?.[1] ?? null;
}

/** Creates a safe, source-derived preview for one inline Ghost syntax node. */
export function renderWikiNode(
  document: Document,
  nodeName: string,
  raw: string,
  onLinkOpen?: (target: string) => void,
): HTMLElement | null {
  if (nodeName === 'GhostWikiLink') {
    const parsed = parseWikiTarget(raw);
    if (!parsed || parsed.embedded) return null;
    const link = document.createElement('span');
    link.className = 'ghost-wiki-link';
    link.dataset.target = parsed.target;
    link.textContent = parsed.alias || parsed.target;
    if (onLinkOpen) {
      link.setAttribute('role', 'link');
      link.tabIndex = 0;
      // Keep CodeMirror focused through pointer activation so its focus handler
      // does not reveal the source token before the click callback runs.
      link.addEventListener('mousedown', (event) => event.preventDefault());
      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        onLinkOpen(parsed.target);
      };
      link.addEventListener('click', activate);
      link.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        activate(event);
      });
    }
    return link;
  }

  if (nodeName === 'GhostTag') {
    const tag = document.createElement('span');
    tag.className = 'ghost-wiki-tag';
    tag.textContent = raw;
    return tag;
  }

  if (nodeName === 'GhostBlockId') {
    const id = raw.replace(/^\^/, '');
    const anchor = document.createElement('span');
    anchor.className = 'ghost-wiki-block-id';
    anchor.dataset.blockId = id;
    anchor.textContent = id;
    return anchor;
  }

  if (nodeName === 'GhostComment') {
    const block = raw.includes('\n');
    const comment = document.createElement(block ? 'div' : 'span');
    comment.className = `ghost-wiki-comment${block ? ' ghost-wiki-comment-block' : ''}`;
    let body = raw.startsWith('%%') && raw.endsWith('%%') ? raw.slice(2, -2) : raw;
    if (block) body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    else body = body.trim();
    comment.textContent = body || raw;
    return comment;
  }

  if (nodeName === 'GhostCalloutMarker') {
    const type = calloutType(raw);
    if (!type) return null;
    const title = document.createElement('span');
    title.className = 'ghost-wiki-callout-title';
    title.dataset.calloutType = type.toLowerCase();
    title.textContent = type;
    return title;
  }

  if (nodeName === 'GhostMathInline' || nodeName === 'GhostMathBlock') {
    return renderWikiMath(document, innerMathSource(nodeName, raw), nodeName === 'GhostMathBlock');
  }

  if (nodeName === 'GhostFootnoteReference') {
    const match = /^\[\^([^\]]+)\]$/.exec(raw);
    if (!match) return null;
    const reference = document.createElement('sup');
    reference.className = 'ghost-wiki-footnote-ref';
    reference.textContent = match[1]!;
    return reference;
  }

  return null;
}
