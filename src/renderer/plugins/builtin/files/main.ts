import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { fileState } from './state';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('refresh', () => {
    fileState.triggerRefresh();
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  fileState.reset();
}

export const SidebarPanel = FileTree;
export const MainPanel = FileViewer;

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
