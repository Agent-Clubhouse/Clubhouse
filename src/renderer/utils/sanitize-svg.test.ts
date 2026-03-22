import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from './sanitize-svg';

describe('sanitizeSvg', () => {
  it('passes through safe SVG markup', () => {
    const svg = '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('<svg');
    expect(result).toContain('circle');
    expect(result).toContain('viewBox="0 0 24 24"');
  });

  it('strips script tags from SVG', () => {
    const malicious = '<svg><script>alert("xss")</script><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<circle');
  });

  it('strips onload event handler attributes', () => {
    const malicious = '<svg onload="alert(1)"><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('onload');
    expect(result).not.toContain('alert');
  });

  it('strips onerror event handler attributes', () => {
    const malicious = '<svg><image href="x" onerror="alert(1)"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });

  it('strips onclick event handler attributes', () => {
    const malicious = '<svg onclick="alert(1)"><rect width="10" height="10"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('onclick');
  });

  it('strips style tags', () => {
    const malicious = '<svg><style>body{background:red}</style><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<style');
    expect(result).toContain('<circle');
  });

  it('preserves SVG attributes like fill, stroke, viewBox', () => {
    const svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 22h20z"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('viewBox');
    expect(result).toContain('fill');
    expect(result).toContain('stroke');
  });

  it('strips javascript: URLs in href', () => {
    const malicious = '<svg><a href="javascript:alert(1)"><circle cx="12" cy="12" r="10"/></a></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('javascript:');
  });
});
