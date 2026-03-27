import { ThemeDefinition } from '../../shared/types';

export function hexToRgbChannels(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r} ${g} ${b}`;
}

export interface ApplyThemeOptions {
  /** When true, apply experimental font and gradient CSS variables from the theme. */
  experimentalGradients?: boolean;
}

export function applyTheme(theme: ThemeDefinition, options?: ApplyThemeOptions): void {
  const s = document.documentElement.style;
  const el = document.documentElement;
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

  // Set shadow CSS variables (theme-aware for light/dark)
  const shadowMap: Record<string, Record<'dark' | 'light', string>> = {
    '--shadow-depth': {
      dark: '0 4px 24px rgba(0, 0, 0, 0.5)',
      light: '0 4px 24px rgba(0, 0, 0, 0.1)',
    },
    '--shadow-elevation': {
      dark: '0 12px 40px rgba(0, 0, 0, 0.6)',
      light: '0 12px 40px rgba(0, 0, 0, 0.08)',
    },
    '--grid-dot-color': {
      dark: 'rgba(255, 255, 255, 0.1)',
      light: 'rgba(0, 0, 0, 0.08)',
    },
  };

  for (const [varName, themeValues] of Object.entries(shadowMap)) {
    const value = themeValues[theme.type];
    s.setProperty(varName, value);
    cache[varName] = value;
  }

  // Font override (Terminal theme)
  if (theme.fontOverride) {
    el.classList.add('theme-mono');
    localStorage.setItem('clubhouse-theme-font', theme.fontOverride);
  } else {
    el.classList.remove('theme-mono');
    localStorage.removeItem('clubhouse-theme-font');
  }

  // Experimental: custom fonts and gradients
  if (options?.experimentalGradients) {
    // Fonts
    if (theme.fonts?.ui) {
      s.setProperty('--theme-font-ui', theme.fonts.ui);
      el.classList.add('theme-font-ui');
      cache['--theme-font-ui'] = theme.fonts.ui;
    } else {
      s.removeProperty('--theme-font-ui');
      el.classList.remove('theme-font-ui');
    }
    if (theme.fonts?.mono) {
      s.setProperty('--theme-font-mono', theme.fonts.mono);
      el.classList.add('theme-font-mono');
      cache['--theme-font-mono'] = theme.fonts.mono;
    } else {
      s.removeProperty('--theme-font-mono');
      el.classList.remove('theme-font-mono');
    }

    // Gradients — class-based on <html> to avoid the Windows compositing
    // bug caused by always setting background-image: none on body.
    if (theme.gradients?.background) {
      s.setProperty('--theme-gradient-bg', theme.gradients.background);
      el.classList.add('theme-gradient-bg');
      cache['--theme-gradient-bg'] = theme.gradients.background;
    } else {
      s.removeProperty('--theme-gradient-bg');
      el.classList.remove('theme-gradient-bg');
    }
    if (theme.gradients?.surface) {
      s.setProperty('--theme-gradient-surface', theme.gradients.surface);
      cache['--theme-gradient-surface'] = theme.gradients.surface;
    } else {
      s.removeProperty('--theme-gradient-surface');
    }
    if (theme.gradients?.accent) {
      s.setProperty('--theme-gradient-accent', theme.gradients.accent);
      cache['--theme-gradient-accent'] = theme.gradients.accent;
    } else {
      s.removeProperty('--theme-gradient-accent');
    }
  } else {
    // Feature disabled — clean up any previously set experimental variables
    s.removeProperty('--theme-font-ui');
    s.removeProperty('--theme-font-mono');
    s.removeProperty('--theme-gradient-bg');
    s.removeProperty('--theme-gradient-surface');
    s.removeProperty('--theme-gradient-accent');
    el.classList.remove('theme-font-ui', 'theme-font-mono');
    el.classList.remove('theme-gradient-bg');
  }

  // Cache to localStorage for flash prevention
  localStorage.setItem('clubhouse-theme-vars', JSON.stringify(cache));
}

/** Generate CSS variable overrides as a style object for scoped theme application (zones). */
export function themeToStyleVars(theme: ThemeDefinition): Record<string, string> {
  const vars: Record<string, string> = {};

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
    vars[varName] = hexToRgbChannels(hex);
  }

  return vars;
}
