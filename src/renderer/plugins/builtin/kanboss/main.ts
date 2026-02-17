import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { kanBossState } from './state';
import { BoardSidebar } from './BoardSidebar';
import { BoardView } from './BoardView';
import { initAutomationEngine, shutdownAutomationEngine } from './AutomationEngine';

// ── activate() ──────────────────────────────────────────────────────────

export function activate(ctx: PluginContext, api: PluginAPI): void {
  // Register commands
  const refreshCmd = api.commands.register('refresh', () => {
    kanBossState.triggerRefresh();
  });
  ctx.subscriptions.push(refreshCmd);

  const newBoardCmd = api.commands.register('new-board', async () => {
    const name = await api.ui.showInput('Board name', 'New Board');
    if (!name) return;
    // The sidebar handles creation — we just trigger a refresh so it picks it up
    // But for command-based creation, we broadcast via state
    kanBossState.triggerRefresh();
  });
  ctx.subscriptions.push(newBoardCmd);

  // Initialize automation engine
  const automationSub = initAutomationEngine(api);
  ctx.subscriptions.push(automationSub);
}

export function deactivate(): void {
  shutdownAutomationEngine();
  kanBossState.reset();
}

export const SidebarPanel = BoardSidebar;
export const MainPanel = BoardView;

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
