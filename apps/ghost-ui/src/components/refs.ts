import type { Element, ElementContent, Root } from 'hast';

/** A machine reference inside prose: an entity id or a content digest. */
export interface Ref { kind: 'id' | 'digest'; value: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Candidates only; a digest also needs a digit and a letter, so plain numbers and words stay text. */
const REF = new RegExp(`(\\()?\\b(${UUID}|[0-9a-f]{12,64})\\b(\\))?`, 'gi');
const WHOLE = new RegExp(`^(?:${UUID}|[0-9a-f]{12,64})$`, 'i');

function refOf(value: string): Ref | null {
  if (value.length === 36 && value.includes('-')) return { kind: 'id', value: value.toLowerCase() };
  return /\d/.test(value) && /[a-f]/i.test(value) ? { kind: 'digest', value: value.toLowerCase() } : null;
}

/**
 * Prose split around machine references. A reference wrapped in its own parentheses takes
 * them along, so "(1adb…)" leaves no empty brackets once it becomes a mark.
 */
export function splitRefs(text: string): Array<string | Ref> {
  const pieces: Array<string | Ref> = [];
  let last = 0;
  for (const match of text.matchAll(REF)) {
    const [whole, open, value, close] = match;
    const ref = refOf(value!);
    if (!ref) continue;
    let start = match.index!;
    let end = start + whole.length;
    // Only a matched pair is absorbed; a lone bracket stays with the prose around it.
    if (open && !close) start += 1;
    if (close && !open) end -= 1;
    if (start > last) pieces.push(text.slice(last, start));
    pieces.push(ref);
    last = end;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

/** The single reference a short code span holds, if that is all it holds. */
export function wholeRef(text: string): Ref | null {
  const value = text.trim();
  return WHOLE.test(value) ? refOf(value) : null;
}

/** The hast element a reference becomes; the transcript renders it as a mark with its details on hover. */
export const REF_TAG = 'ghost-ref';

const refNode = (ref: Ref): Element => ({ type: 'element', tagName: REF_TAG, properties: { dataKind: ref.kind, dataValue: ref.value }, children: [] });

/** Text that keeps its exact characters: code blocks, links and marks already made. */
const SKIP: Record<string, true> = { pre: true, a: true, [REF_TAG]: true, svg: true };

/** Replaces ids and digests in prose and in bare inline code with reference marks. */
export function rehypeRefs() {
  const visit = (parent: Root | Element) => {
    const next: ElementContent[] = [];
    let changed = false;
    for (const child of parent.children) {
      if (child.type === 'text') {
        const pieces = splitRefs(child.value);
        if (pieces.length === 1 && typeof pieces[0] === 'string') { next.push(child); continue; }
        changed = true;
        for (const piece of pieces) next.push(typeof piece === 'string' ? { type: 'text', value: piece } : refNode(piece));
      } else if (child.type === 'element') {
        if (child.tagName === 'code') {
          const only = child.children.length === 1 && child.children[0]!.type === 'text' ? wholeRef(child.children[0].value) : null;
          if (only) { next.push(refNode(only)); changed = true; continue; }
          next.push(child);
          continue;
        }
        if (!SKIP[child.tagName]) visit(child);
        next.push(child);
      } else if (child.type !== 'doctype') {
        next.push(child);
      }
    }
    if (changed) parent.children = next;
  };
  return (tree: Root) => visit(tree);
}
