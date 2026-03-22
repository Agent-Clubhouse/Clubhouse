import DOMPurify from 'dompurify';

/**
 * Sanitize an SVG string for safe use with dangerouslySetInnerHTML.
 * Strips script-bearing elements and event handler attributes (onload, onerror, etc.).
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'style'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onanimationend'],
  });
}
