import DOMPurify from 'dompurify';

/** SVG elements safe for rendering plugin icons. */
const SVG_ALLOWED_TAGS = [
  'svg', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon',
  'g', 'defs', 'clipPath', 'mask', 'use',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop',
];

/** SVG presentation attributes safe for plugin icons. */
const SVG_ALLOWED_ATTR = [
  'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
  'points', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity',
  'xmlns', 'clip-path', 'clip-rule', 'fill-rule', 'mask', 'id',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'text-anchor', 'font-size', 'font-family', 'font-weight',
];

/**
 * Sanitize an SVG string for safe use with dangerouslySetInnerHTML.
 * Uses an allowlist of SVG elements and presentation attributes — blocks
 * foreignObject, script, style, image, a, animate*, and all event handlers.
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    ALLOWED_TAGS: SVG_ALLOWED_TAGS,
    ALLOWED_ATTR: SVG_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}
