import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { reviewNav } from './commands';
import { MainPanel } from './ReviewPanel';

export { MainPanel };
export { filterAgents, filterNeedsAttention, filterRemoteAgents, resolveIndex, clampIndex } from './filters';

// ── Activate / Deactivate ──────────────────────────────────────────────

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const prevDisp = api.commands.register('review-prev', () => reviewNav.prev?.());
  const nextDisp = api.commands.register('review-next', () => reviewNav.next?.());
  ctx.subscriptions.push(prevDisp, nextDisp);
}

export function deactivate(): void {
  reviewNav.prev = null;
  reviewNav.next = null;
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
