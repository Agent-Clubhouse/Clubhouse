/**
 * The shared seam for rich chat content (#2349): a pass over rendered,
 * sanitized markdown that swaps matched spans of plain text for nodes. Text
 * inside code, preformatted blocks and existing links is never touched, and
 * every node a matcher makes is built with DOM APIs, not HTML strings.
 */

export interface TextMatch {
  start: number;
  end: number;
  make: (doc: Document) => Node;
}

/** Finds spans in one text node's text; earlier matchers win where spans overlap. */
export type TextMatcher = (text: string) => TextMatch[];

/** Elements whose text is left exactly as written. */
const SKIP = new Set(['CODE', 'PRE', 'A', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA']);

function skipped(node: Node, root: Node): boolean {
  for (let el = node.parentNode; el && el !== root; el = el.parentNode) {
    if (el.nodeType === 1 && SKIP.has((el as Element).tagName)) return true;
  }
  return false;
}

/** Non-overlapping matches from all matchers, in text order. */
export function collectMatches(text: string, matchers: TextMatcher[]): TextMatch[] {
  const picked: TextMatch[] = [];
  for (const matcher of matchers) {
    for (const m of matcher(text)) {
      if (m.end <= m.start || picked.some((p) => m.start < p.end && m.end > p.start)) continue;
      picked.push(m);
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** Replace matched text under `root` in place. Returns how many matches were made. */
export function enrichTextNodes(root: Element, matchers: TextMatcher[]): number {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!skipped(n, root)) nodes.push(n as Text);
  }
  let count = 0;
  for (const node of nodes) {
    const text = node.data;
    const matches = collectMatches(text, matchers);
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const m of matches) {
      if (m.start > at) frag.appendChild(doc.createTextNode(text.slice(at, m.start)));
      frag.appendChild(m.make(doc));
      at = m.end;
    }
    if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
    node.parentNode!.replaceChild(frag, node);
    count += matches.length;
  }
  return count;
}
