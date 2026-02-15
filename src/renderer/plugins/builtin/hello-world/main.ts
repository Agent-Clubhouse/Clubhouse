import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const greeting = (ctx.settings.greeting as string) ?? 'Hello from a built-in plugin!';

  const disposable = api.commands.register('greet', () => {
    api.ui.showNotice(greeting);
  });

  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  // no-op — subscriptions auto-disposed by the plugin loader
}

// Compile-time type assertion: ensures this module satisfies PluginModule
const _: PluginModule = { activate, deactivate };
void _;
