import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { GroupProjectCanvasWidget } from './GroupProjectCanvasWidget';
import { initGroupProjectListener } from '../../../stores/groupProjectStore';

let cleanupListener: (() => void) | null = null;

export function activate(ctx: PluginContext, api: PluginAPI): void {
  // Register canvas widget
  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'group-project',
      component: GroupProjectCanvasWidget,
      generateDisplayName: (metadata) => {
        if (metadata.name && typeof metadata.name === 'string') {
          return metadata.name;
        }
        return 'Group Project';
      },
    }),
  );

  // Initialize cross-window sync listener
  cleanupListener = initGroupProjectListener();
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
