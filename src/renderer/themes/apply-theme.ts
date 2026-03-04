import { ThemeDefinition } from '../../shared/types';

function hexToRgbChannels(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export function applyTheme(theme: ThemeDefinition): void {
  const s = document.documentElement.style;
  const cache: Record<string, string> = {};

  // Set color CSS variables (space-separated RGB channels)
  const colorMap: Record<string, string> = {
    '--ctp-base': theme.colors.base,
    '--ctp-mantle': theme.colors.mantle,
    '--ctp-crust': theme.colors.crust,
    '--ctp-text': theme.colors.text,
    '--ctp-subtext0': theme.colors.subtext0,
    '--ctp-subtext1': theme.colors.subtext1,
    '--ctp-surface0': theme.colors.surface0,
    '--ctp-surface1': theme.colors.surface1,
    '--ctp-surface2': theme.colors.surface2,
    '--ctp-accent': theme.colors.accent,
    '--ctp-link': theme.colors.link,
    '--ctp-warning': theme.colors.warning,
    '--ctp-error': theme.colors.error,
    '--ctp-info': theme.colors.info,
    '--ctp-success': theme.colors.success,
  };

  for (const [varName, hex] of Object.entries(colorMap)) {
    const rgb = hexToRgbChannels(hex);
    s.setProperty(varName, rgb);
    cache[varName] = rgb;
  }

  // Set highlight.js CSS variables (hex values)
  const hljsMap: Record<string, string> = {
    '--hljs-keyword': theme.hljs.keyword,
    '--hljs-string': theme.hljs.string,
    '--hljs-number': theme.hljs.number,
    '--hljs-comment': theme.hljs.comment,
    '--hljs-function': theme.hljs.function,
    '--hljs-type': theme.hljs.type,
    '--hljs-variable': theme.hljs.variable,
    '--hljs-regexp': theme.hljs.regexp,
    '--hljs-tag': theme.hljs.tag,
    '--hljs-attribute': theme.hljs.attribute,
    '--hljs-symbol': theme.hljs.symbol,
    '--hljs-meta': theme.hljs.meta,
    '--hljs-addition': theme.hljs.addition,
    '--hljs-deletion': theme.hljs.deletion,
    '--hljs-property': theme.hljs.property,
    '--hljs-punctuation': theme.hljs.punctuation,
  };

  for (const [varName, hex] of Object.entries(hljsMap)) {
    s.setProperty(varName, hex);
    cache[varName] = hex;
  }

  // Font overrides — new `fonts` field takes precedence over legacy `fontOverride`.
  // CSS variables are consumed directly via var() fallbacks in index.css, so we only
  // need to set/remove the variables (no class toggling for individual font overrides).
  const uiFont = theme.fonts?.ui;
  const monoFont = theme.fonts?.mono ?? theme.fontOverride;

  if (uiFont) {
    s.setProperty('--theme-font-ui', uiFont);
    cache['--theme-font-ui'] = uiFont;
  } else {
    s.removeProperty('--theme-font-ui');
  }

  if (monoFont) {
    s.setProperty('--theme-font-mono', monoFont);
    cache['--theme-font-mono'] = monoFont;
  } else {
    s.removeProperty('--theme-font-mono');
  }

  // Full-mono class: when both ui + mono are set, apply mono everywhere
  if (uiFont && monoFont) {
    document.documentElement.classList.add('theme-mono');
    localStorage.setItem('clubhouse-theme-font', monoFont);
  } else {
    document.documentElement.classList.remove('theme-mono');
    localStorage.removeItem('clubhouse-theme-font');
  }

  // Gradient decorations
  const gradientMap: Record<string, string | undefined> = {
    '--theme-gradient-bg': theme.gradients?.background,
    '--theme-gradient-surface': theme.gradients?.surface,
    '--theme-gradient-accent': theme.gradients?.accent,
  };

  for (const [varName, value] of Object.entries(gradientMap)) {
    if (value) {
      s.setProperty(varName, value);
      cache[varName] = value;
    } else {
      s.removeProperty(varName);
    }
  }

  // Cache to localStorage for flash prevention
  localStorage.setItem('clubhouse-theme-vars', JSON.stringify(cache));
}
