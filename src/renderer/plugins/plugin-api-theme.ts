import type { PluginContext, ThemeAPI, ThemeInfo, Disposable } from '../../shared/plugin-types';
import { useThemeStore } from '../stores/themeStore';

export function buildThemeInfo(): ThemeInfo {
  const state = useThemeStore.getState();
  const theme = state.theme;
  const info: ThemeInfo = {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    colors: { ...theme.colors },
    hljs: { ...theme.hljs },
    terminal: { ...theme.terminal },
  };
  // Only expose fonts/gradients when the experimental flag is on
  if (state.experimentalGradients) {
    if (theme.fonts) info.fonts = { ...theme.fonts };
    if (theme.gradients) info.gradients = { ...theme.gradients };
  }
  return info;
}

export function createThemeAPI(ctx: PluginContext): ThemeAPI {
  return {
    getCurrent(): ThemeInfo {
      return buildThemeInfo();
    },
    onDidChange(callback: (theme: ThemeInfo) => void): Disposable {
      // Track the applied theme, not the selection: when the selected plugin theme is
      // unregistered the store keeps themeId and only swaps in the fallback theme.
      // The definition, not just its id: a pack update re-registers the same id
      // with new colours (#2123).
      let prev = useThemeStore.getState().theme;
      const unsub = useThemeStore.subscribe((state) => {
        if (state.theme !== prev) {
          prev = state.theme;
          const info: ThemeInfo = {
            id: state.theme.id,
            name: state.theme.name,
            type: state.theme.type,
            colors: { ...state.theme.colors },
            hljs: { ...state.theme.hljs },
            terminal: { ...state.theme.terminal },
          };
          if (state.experimentalGradients) {
            if (state.theme.fonts) info.fonts = { ...state.theme.fonts };
            if (state.theme.gradients) info.gradients = { ...state.theme.gradients };
          }
          callback(info);
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
