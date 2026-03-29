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

  // --- SEC-09 regression tests: allowlist enforcement ---

  it('strips foreignObject elements (HTML injection vector)', () => {
    const malicious = '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><div onclick="alert(1)">click</div></body></foreignObject></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('foreignObject');
    expect(result).not.toContain('<body');
    expect(result).not.toContain('<div');
    expect(result).not.toContain('onclick');
  });

  it('strips image elements (external resource loading)', () => {
    const malicious = '<svg><image href="https://evil.com/track.png" width="100" height="100"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<image');
    expect(result).not.toContain('evil.com');
  });

  it('strips anchor elements', () => {
    const malicious = '<svg><a href="https://evil.com"><circle cx="12" cy="12" r="10"/></a></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<a');
    expect(result).not.toContain('evil.com');
  });

  it('strips animate elements (potential CSS/behavior injection)', () => {
    const malicious = '<svg><rect width="10" height="10"><animate attributeName="width" from="10" to="100" dur="1s"/></rect></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<animate');
  });

  it('strips animateTransform elements', () => {
    const malicious = '<svg><rect width="10" height="10"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s"/></rect></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('animateTransform');
  });

  it('strips data: attributes', () => {
    const malicious = '<svg data-payload="malicious"><circle cx="12" cy="12" r="10"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('data-payload');
  });

  it('preserves gradient elements', () => {
    const svg = '<svg><defs><linearGradient id="g1"><stop offset="0%" stop-color="red"/><stop offset="100%" stop-color="blue"/></linearGradient></defs><rect fill="url(#g1)" width="10" height="10"/></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('linearGradient');
    expect(result).toContain('stop');
    expect(result).toContain('stop-color');
  });

  it('preserves text elements', () => {
    const svg = '<svg><text x="10" y="20" font-size="14" font-family="sans-serif">Hello</text></svg>';
    const result = sanitizeSvg(svg);
    expect(result).toContain('<text');
    expect(result).toContain('Hello');
  });

  it('strips set elements (SMIL animation)', () => {
    const malicious = '<svg><rect width="10" height="10"><set attributeName="fill" to="red"/></rect></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<set');
  });
});
