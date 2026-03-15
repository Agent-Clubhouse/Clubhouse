import type { PluginContext, ThemeAPI, ThemeInfo, Disposable } from '../../shared/plugin-types';

export function buildThemeInfo(): ThemeInfo {
  // Lazy import to avoid circular deps — only needed when a plugin uses the theme API
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useThemeStore } = require('../stores/themeStore');
  const state = useThemeStore.getState();
  const theme = state.theme;
  return {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    colors: { ...theme.colors },
    hljs: { ...theme.hljs },
    terminal: { ...theme.terminal },
  };
}

export function createThemeAPI(ctx: PluginContext): ThemeAPI {
  return {
    getCurrent(): ThemeInfo {
      return buildThemeInfo();
    },
    onDidChange(callback: (theme: ThemeInfo) => void): Disposable {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useThemeStore } = require('../stores/themeStore');
      let prevId = useThemeStore.getState().themeId;
      const unsub = useThemeStore.subscribe((state: { themeId: string; theme: { id: string; name: string; type: 'dark' | 'light'; colors: Record<string, string>; hljs: Record<string, string>; terminal: Record<string, string> } }) => {
        if (state.themeId !== prevId) {
          prevId = state.themeId;
          callback({
            id: state.theme.id,
            name: state.theme.name,
            type: state.theme.type,
            colors: { ...state.theme.colors },
            hljs: { ...state.theme.hljs },
            terminal: { ...state.theme.terminal },
          });
        }
      });
      const disposable = { dispose: unsub };
      ctx.subscriptions.push(disposable);
      return disposable;
    },
    getColor(token: string): string | null {
      const info = buildThemeInfo();
      // Support dotted notation: 'hljs.keyword', 'terminal.red', or plain 'accent'
      if (token.startsWith('hljs.')) {
        const key = token.slice(5);
        return (info.hljs as Record<string, string>)[key] ?? null;
      }
      if (token.startsWith('terminal.')) {
        const key = token.slice(9);
        return (info.terminal as Record<string, string>)[key] ?? null;
      }
      return (info.colors as Record<string, string>)[token] ?? null;
    },
  };
}
