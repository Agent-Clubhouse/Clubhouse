import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { AgentQueueCanvasWidget } from './AgentQueueCanvasWidget';
import { initAgentQueueListener } from '../../../stores/agentQueueStore';

let cleanupListener: (() => void) | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'agent-queue',
      component: AgentQueueCanvasWidget,
      generateDisplayName: (metadata) => {
        if (metadata.name && typeof metadata.name === 'string') {
          return metadata.name;
        }
        return 'Agent Queue';
      },
    }),
  );

  cleanupListener = initAgentQueueListener();
}

export function deactivate(): void {
  if (cleanupListener) {
    cleanupListener();
    cleanupListener = null;
  }
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate };
void _;
