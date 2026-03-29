import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import { StickyNoteCanvasWidget } from './StickyNoteCanvasWidget';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  ctx.subscriptions.push(
    api.canvas.registerWidgetType({
      id: 'note',
      component: StickyNoteCanvasWidget,
    }),
  );
}

export function deactivate(): void {}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate };
void _;
