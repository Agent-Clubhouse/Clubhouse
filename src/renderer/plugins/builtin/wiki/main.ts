import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { wikiState } from './state';
import { WikiTree } from './WikiTree';
import { WikiViewer } from './WikiViewer';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('refresh', () => {
    wikiState.triggerRefresh();
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  wikiState.reset();
}

export const SidebarPanel = WikiTree;
export const MainPanel = WikiViewer;

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
