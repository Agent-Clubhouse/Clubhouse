import React from 'react';
import { showInputDialog, showConfirmDialog } from './PluginDialog';
import type {
  PluginContext,
  UIAPI,
  CommandsAPI,
  EventsAPI,
  NavigationAPI,
  WidgetsAPI,
  HubAPI,
  Disposable,
} from '../../shared/plugin-types';
import { pluginEventBus } from './plugin-events';
import { pluginCommandRegistry } from './plugin-commands';
import { pluginHotkeyRegistry } from './plugin-hotkeys';
import { useAgentStore } from '../stores/agentStore';
import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';

export function createUIAPI(ctx: PluginContext): UIAPI {
  return {
    showNotice(message: string): void {
      // Simple notification using existing notification system
      console.log(`[Plugin Notice] ${message}`);
    },
    showError(message: string): void {
      console.error(`[Plugin Error] ${message}`);
    },
    async showConfirm(message: string): Promise<boolean> {
      const { promise, cleanup } = showConfirmDialog(message);
      ctx.subscriptions.push({ dispose: cleanup });
      return promise;
    },
    async showInput(prompt: string, defaultValue = ''): Promise<string | null> {
      const { promise, cleanup } = showInputDialog(prompt, defaultValue);
      ctx.subscriptions.push({ dispose: cleanup });
      return promise;
    },
    async openExternalUrl(url: string): Promise<void> {
      await window.clubhouse.app.openExternalUrl(url);
    },
  };
}

export function createCommandsAPI(ctx: PluginContext): CommandsAPI {
  return {
    register(commandId: string, handler: (...args: unknown[]) => void | Promise<void>): Disposable {
      const fullId = `${ctx.pluginId}:${commandId}`;
      return pluginCommandRegistry.register(fullId, handler);
    },
    async execute(commandId: string, ...args: unknown[]): Promise<void> {
      // Try with plugin prefix first, then raw
      const fullId = `${ctx.pluginId}:${commandId}`;
      if (pluginCommandRegistry.has(fullId)) {
        await pluginCommandRegistry.execute(fullId, ...args);
      } else {
        await pluginCommandRegistry.execute(commandId, ...args);
      }
    },
    registerWithHotkey(
      commandId: string,
      title: string,
      handler: (...args: unknown[]) => void | Promise<void>,
      defaultBinding: string,
      options?: { global?: boolean },
    ): Disposable {
      const fullId = `${ctx.pluginId}:${commandId}`;
      const cmdDisposable = pluginCommandRegistry.register(fullId, handler);
      const hotkeyDisposable = pluginHotkeyRegistry.register(
        ctx.pluginId,
        commandId,
        title,
        handler,
        defaultBinding,
        options,
      );
      return {
        dispose: () => {
          cmdDisposable.dispose();
          hotkeyDisposable.dispose();
        },
      };
    },
    getBinding(commandId: string): string | null {
      return pluginHotkeyRegistry.getBinding(ctx.pluginId, commandId);
    },
    clearBinding(commandId: string): void {
      pluginHotkeyRegistry.clearBinding(ctx.pluginId, commandId);
    },
  };
}

export function createEventsAPI(): EventsAPI {
  return {
    on(event: string, handler: (...args: unknown[]) => void): Disposable {
      return pluginEventBus.on(event, handler);
    },
  };
}

export function createHubAPI(): HubAPI {
  return {};
}

export function createNavigationAPI(): NavigationAPI {
  return {
    focusAgent(agentId: string): void {
      const agent = useAgentStore.getState().agents[agentId];
      const projectId = agent?.projectId || useProjectStore.getState().activeProjectId || undefined;
      useUIStore.getState().setExplorerTab('agents', projectId);
      useAgentStore.getState().setActiveAgent(agentId, projectId);
    },
    setExplorerTab(tabId: string): void {
      const projectId = useProjectStore.getState().activeProjectId || undefined;
      useUIStore.getState().setExplorerTab(tabId, projectId);
    },
    async popOutAgent(agentId: string): Promise<void> {
      const agent = useAgentStore.getState().agents[agentId];
      await window.clubhouse.window.createPopout({
        type: 'agent',
        agentId,
        projectId: agent?.projectId,
        title: agent?.name,
      });
    },
    toggleSidebar(): void {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { usePanelStore } = require('../stores/panelStore');
        usePanelStore.getState().toggleExplorerCollapse();
      } catch { /* ignore in test */ }
    },
    toggleAccessoryPanel(): void {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { usePanelStore } = require('../stores/panelStore');
        usePanelStore.getState().toggleAccessoryCollapse();
      } catch { /* ignore in test */ }
    },
  };
}

let _widgetsCache: WidgetsAPI | null = null;

export function createWidgetsAPI(): WidgetsAPI {
  if (_widgetsCache) return _widgetsCache;

  // Lazy imports to avoid circular deps — these are only needed when a plugin renders widgets.
  // Wrapped in try/catch for test environments where these modules may not be available.

  let AgentTerminalComponent: React.ComponentType<any>;

  let SleepingAgentComponent: React.ComponentType<any>;

  let AgentAvatarComponent: React.ComponentType<any>;

  let QuickAgentGhostComponent: React.ComponentType<any>;


  let AgentAvatarWithRingComponent: React.ComponentType<any>;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    AgentTerminalComponent = require('../features/agents/AgentTerminal').AgentTerminal;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SleepingAgentComponent = require('../features/agents/SleepingAgent').SleepingAgent;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    AgentAvatarComponent = require('../features/agents/AgentAvatar').AgentAvatar;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    AgentAvatarWithRingComponent = require('../features/agents/AgentAvatar').AgentAvatarWithRing;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    QuickAgentGhostComponent = require('../features/agents/QuickAgentGhost').QuickAgentGhost;
  } catch {
    // In test environments, return stub components
    const stub = ((): null => null) as unknown as React.ComponentType<any>;
    _widgetsCache = {
      AgentTerminal: stub,
      SleepingAgent: stub,
      AgentAvatar: stub,
      QuickAgentGhost: stub,
    };
    return _widgetsCache;
  }

  // SleepingAgent adapter: plugin passes agentId, we resolve to Agent reactively
  const SleepingAgentAdapter = ({ agentId }: { agentId: string }) => {
    const agent = useAgentStore((s) => s.agents[agentId]);
    if (!agent) return null;
    return React.createElement(SleepingAgentComponent, { agent });
  };

  // AgentAvatar adapter: when showStatusRing is true, use the ring variant with status colors
  const AgentAvatarAdapter = ({ agentId, size, showStatusRing }: { agentId: string; size?: 'sm' | 'md'; showStatusRing?: boolean }) => {
    const agent = useAgentStore((s) => s.agents[agentId]);
    if (!agent) return null;
    if (showStatusRing && AgentAvatarWithRingComponent) {
      return React.createElement(AgentAvatarWithRingComponent, { agent });
    }
    return React.createElement(AgentAvatarComponent, { agent, size });
  };

  _widgetsCache = {
    AgentTerminal: AgentTerminalComponent,
    SleepingAgent: SleepingAgentAdapter,
    AgentAvatar: AgentAvatarAdapter,
    QuickAgentGhost: QuickAgentGhostComponent,
  };
  return _widgetsCache;
}
