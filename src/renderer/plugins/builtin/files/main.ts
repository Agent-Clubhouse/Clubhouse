import React, { useState, useEffect } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { fileState } from './state';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { SearchPanel } from './SearchPanel';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const refreshDisposable = api.commands.register('refresh', () => {
    fileState.triggerRefresh();
  });
  ctx.subscriptions.push(refreshDisposable);

  const searchDisposable = api.commands.register('search', () => {
    fileState.setSearchMode(true);
  });
  ctx.subscriptions.push(searchDisposable);
}

export function deactivate(): void {
  fileState.reset();
}

function SidebarWrapper({ api }: { api: PluginAPI }) {
  const [searchMode, setSearchMode] = useState(fileState.searchMode);

  useEffect(() => {
    return fileState.subscribe(() => {
      setSearchMode(fileState.searchMode);
    });
  }, []);

  if (searchMode) {
    return React.createElement(SearchPanel, { api });
  }
  return React.createElement(FileTree, { api });
}

export const SidebarPanel = SidebarWrapper;
export const MainPanel = FileViewer;

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
