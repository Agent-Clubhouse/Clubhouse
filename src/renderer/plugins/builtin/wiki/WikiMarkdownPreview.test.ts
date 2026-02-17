import { describe, it, expect } from 'vitest';
import { createWikiLinkExtension, renderWikiMarkdown } from './WikiMarkdownPreview';

// ── createWikiLinkExtension ─────────────────────────────────────────

describe('createWikiLinkExtension', () => {
  it('tokenizes [[Page Name]] syntax', () => {
    const ext = createWikiLinkExtension(['Getting Started']);
    const result = ext.tokenizer('[[Getting Started]] and more');
    expect(result).toBeDefined();
    expect(result!.type).toBe('wikiLink');
    expect(result!.raw).toBe('[[Getting Started]]');
    expect(result!.pageName).toBe('Getting Started');
  });

  it('returns undefined for non-wiki-link text', () => {
    const ext = createWikiLinkExtension([]);
    expect(ext.tokenizer('no wiki links here')).toBeUndefined();
  });

  it('renders valid link with wiki-link class', () => {
    const ext = createWikiLinkExtension(['My Page']);
    const html = ext.renderer({ pageName: 'My Page' });
    expect(html).toContain('class="wiki-link"');
    expect(html).toContain('data-wiki-link="My Page"');
    expect(html).not.toContain('wiki-link-broken');
  });

  it('renders broken link with wiki-link-broken class', () => {
    const ext = createWikiLinkExtension(['Other Page']);
    const html = ext.renderer({ pageName: 'Missing Page' });
    expect(html).toContain('wiki-link-broken');
    expect(html).toContain('data-wiki-link="Missing Page"');
  });

  it('matches case-insensitively', () => {
    const ext = createWikiLinkExtension(['Getting Started']);
    const html = ext.renderer({ pageName: 'getting started' });
    expect(html).toContain('class="wiki-link"');
    expect(html).not.toContain('wiki-link-broken');
  });

  it('strips .md extension from page names for matching', () => {
    const ext = createWikiLinkExtension(['README.md']);
    const html = ext.renderer({ pageName: 'README' });
    expect(html).toContain('class="wiki-link"');
    expect(html).not.toContain('wiki-link-broken');
  });

  it('start() finds opening bracket position', () => {
    const ext = createWikiLinkExtension([]);
    expect(ext.start('foo [[bar]]')).toBe(4);
    expect(ext.start('no brackets')).toBe(-1);
  });
});

// ── renderWikiMarkdown ──────────────────────────────────────────────

describe('renderWikiMarkdown', () => {
  it('renders wiki links with data-wiki-link attributes', () => {
    const html = renderWikiMarkdown('See [[My Page]] for details.', ['My Page']);
    expect(html).toContain('data-wiki-link="My Page"');
    expect(html).toContain('class="wiki-link"');
  });

  it('marks broken links with wiki-link-broken class', () => {
    const html = renderWikiMarkdown('See [[Missing]] here.', ['Other']);
    expect(html).toContain('wiki-link-broken');
  });

  it('renders standard markdown alongside wiki links', () => {
    const html = renderWikiMarkdown('# Title\n\nSee [[Page]]', ['Page']);
    expect(html).toContain('<h1');
    expect(html).toContain('data-wiki-link="Page"');
  });

  it('renders multiple wiki links in one line', () => {
    const html = renderWikiMarkdown('Link [[A]] and [[B]].', ['A', 'B']);
    expect(html).toMatch(/data-wiki-link="A"/);
    expect(html).toMatch(/data-wiki-link="B"/);
  });

  it('handles content with no wiki links', () => {
    const html = renderWikiMarkdown('# Just markdown\n\nHello world', []);
    expect(html).toContain('<h1');
    expect(html).toContain('Hello world');
    expect(html).not.toContain('data-wiki-link');
  });

  it('renders code blocks correctly', () => {
    const html = renderWikiMarkdown('```javascript\nconst x = 1;\n```', []);
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
  });
});
