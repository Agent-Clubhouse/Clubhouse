import React, { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '../../../stores/themeStore';

type MermaidModule = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
  parse: (text: string, options?: { suppressErrors?: boolean }) => Promise<unknown>;
};

let mermaidPromise: Promise<MermaidModule> | null = null;
let renderCounter = 0;

/** Lazy-load mermaid so the file plugin doesn't pay the bundle cost unless a diagram is rendered. */
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default as unknown as MermaidModule);
  }
  return mermaidPromise;
}

/** Resolve a Clubhouse CSS variable to a usable color string.
 *  CTP variables are stored as space-separated RGB channels (e.g. "30 30 46"); other vars are hex. */
function resolveCssColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!value) return fallback;
  if (/^\d+\s+\d+\s+\d+$/.test(value)) {
    const [r, g, b] = value.split(/\s+/);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return value;
}

function buildThemeVariables(themeType: 'dark' | 'light'): Record<string, string> {
  const surface0 = resolveCssColor('--ctp-surface0', themeType === 'dark' ? '#313244' : '#ccd0da');
  const surface1 = resolveCssColor('--ctp-surface1', themeType === 'dark' ? '#45475a' : '#bcc0cc');
  const text = resolveCssColor('--ctp-text', themeType === 'dark' ? '#cdd6f4' : '#4c4f69');
  const subtext0 = resolveCssColor('--ctp-subtext0', themeType === 'dark' ? '#a6adc8' : '#6c6f85');
  const overlay0 = resolveCssColor('--ctp-overlay0', themeType === 'dark' ? '#6c7086' : '#9ca0b0');
  const base = resolveCssColor('--ctp-base', themeType === 'dark' ? '#1e1e2e' : '#eff1f5');
  const mantle = resolveCssColor('--ctp-mantle', themeType === 'dark' ? '#181825' : '#e6e9ef');
  const error = resolveCssColor('--ctp-error', themeType === 'dark' ? '#f38ba8' : '#d20f39');

  return {
    background: base,
    primaryColor: surface0,
    primaryTextColor: text,
    primaryBorderColor: overlay0,
    secondaryColor: surface1,
    secondaryTextColor: text,
    secondaryBorderColor: overlay0,
    tertiaryColor: mantle,
    tertiaryTextColor: text,
    tertiaryBorderColor: overlay0,
    lineColor: subtext0,
    textColor: text,
    mainBkg: surface0,
    nodeBorder: overlay0,
    nodeTextColor: text,
    edgeLabelBackground: base,
    clusterBkg: mantle,
    clusterBorder: overlay0,
    titleColor: text,
    noteBkgColor: surface1,
    noteBorderColor: overlay0,
    noteTextColor: text,
    errorBkgColor: error,
    errorTextColor: text,
    actorBkg: surface0,
    actorBorder: overlay0,
    actorTextColor: text,
    actorLineColor: subtext0,
    signalColor: subtext0,
    signalTextColor: text,
    labelBoxBkgColor: surface1,
    labelBoxBorderColor: overlay0,
    labelTextColor: text,
    loopTextColor: text,
    activationBkgColor: surface1,
    activationBorderColor: overlay0,
  };
}

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps): React.ReactElement {
  const themeId = useThemeStore((s) => s.themeId);
  const themeType = useThemeStore((s) => s.theme.type);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderToken = useRef(0);

  useEffect(() => {
    const myToken = ++renderToken.current;
    setSvg(null);
    setError(null);

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          darkMode: themeType === 'dark',
          fontFamily: 'inherit',
          themeVariables: buildThemeVariables(themeType),
        });
        await mermaid.parse(code);
        const id = `clubhouse-mermaid-${++renderCounter}`;
        const result = await mermaid.render(id, code);
        if (myToken !== renderToken.current) return;
        setSvg(result.svg);
      } catch (err) {
        if (myToken !== renderToken.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    })();
  }, [code, themeId, themeType]);

  if (error !== null) {
    return React.createElement(
      'div',
      { className: 'my-4 rounded border border-ctp-error/40 overflow-hidden', role: 'alert' },
      React.createElement(
        'div',
        { className: 'px-3 py-1.5 text-xs bg-ctp-error/10 text-ctp-error font-medium' },
        `Mermaid diagram error: ${error}`,
      ),
      React.createElement(
        'pre',
        { className: 'hljs language-mermaid !mt-0 !rounded-none' },
        React.createElement('code', { className: 'hljs language-mermaid' }, code),
      ),
    );
  }

  if (svg === null) {
    return React.createElement(
      'div',
      {
        className: 'my-4 px-3 py-2 text-xs text-ctp-subtext0 italic',
        'aria-busy': 'true',
      },
      'Rendering diagram…',
    );
  }

  return React.createElement('div', {
    className: 'mermaid-diagram my-4 flex justify-center overflow-auto',
    'data-testid': 'mermaid-diagram',
    dangerouslySetInnerHTML: { __html: svg },
  });
}
