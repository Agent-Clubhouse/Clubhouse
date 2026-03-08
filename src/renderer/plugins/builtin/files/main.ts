import React, { useState, useEffect } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { fileState } from './state';
import { disposeAllModels } from './MonacoEditor';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';
import { SearchPanel } from './SearchPanel';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  // Refresh file tree command
  ctx.subscriptions.push(
    api.commands.register('refresh', () => {
      fileState.triggerRefresh();
    }),
  );

  // Search across files — Meta+Shift+F
  ctx.subscriptions.push(
    api.commands.register('search', () => {
      fileState.setSearchMode(true);
    }),
  );

  // Close active tab — Meta+Shift+W
  ctx.subscriptions.push(
    api.commands.registerWithHotkey(
      'close-tab',
      'Close Active Tab',
      () => {
        const activeTab = fileState.getActiveTab();
        if (activeTab && !activeTab.isPinned && !activeTab.isDirty) {
          fileState.closeTab(activeTab.id);
        }
        // If dirty or pinned, the FileViewer handleCloseTab handles it with dialog
      },
      'Meta+Shift+W',
    ),
  );

  // Reopen last closed tab — Meta+Shift+L
  ctx.subscriptions.push(
    api.commands.registerWithHotkey(
      'reopen-tab',
      'Reopen Last Closed Tab',
      () => {
        fileState.reopenLastClosed();
      },
      'Meta+Shift+L',
    ),
  );

  // Next tab — Meta+Shift+]
  ctx.subscriptions.push(
    api.commands.registerWithHotkey(
      'next-tab',
      'Next Tab',
      () => {
        const tabs = fileState.getOrderedTabs();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex(t => t.id === fileState.activeTabId);
        const next = tabs[(idx + 1) % tabs.length];
        if (next) fileState.activateTab(next.id);
      },
      'Meta+Shift+]',
    ),
  );

  // Previous tab — Meta+Shift+[
  ctx.subscriptions.push(
    api.commands.registerWithHotkey(
      'prev-tab',
      'Previous Tab',
      () => {
        const tabs = fileState.getOrderedTabs();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex(t => t.id === fileState.activeTabId);
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
        if (prev) fileState.activateTab(prev.id);
      },
      'Meta+Shift+[',
    ),
  );
}

export function deactivate(): void {
  fileState.reset();
  disposeAllModels();
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
