import React, { useMemo } from 'react';
import { sanitizeSvg } from '../utils/sanitize-svg';

/**
 * Renders a plugin/template-supplied SVG string after sanitizing it.
 *
 * React 19 re-applies `dangerouslySetInnerHTML` whenever the `{ __html }`
 * object changes identity, not when the string changes. An inline object
 * therefore rebuilds the SVG subtree on every parent render, and a rebuild
 * landing between pointerdown and pointerup swallows the click on the
 * enclosing button. Memoizing on the source string keeps the DOM stable.
 */
export const SanitizedSvg = React.memo(function SanitizedSvg({ svg, className }: { svg: string; className?: string }) {
  const html = useMemo(() => ({ __html: sanitizeSvg(svg) }), [svg]);
  return <span className={className} dangerouslySetInnerHTML={html} />;
});
