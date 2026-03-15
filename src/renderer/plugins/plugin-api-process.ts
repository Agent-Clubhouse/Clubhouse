import type { PluginContext, PluginManifest, ProcessAPI } from '../../shared/plugin-types';

export function createProcessAPI(ctx: PluginContext, _manifest?: PluginManifest): ProcessAPI {
  const { pluginId } = ctx;
  return {
    async exec(command, args, options?) {
      return window.clubhouse.process.exec({
        pluginId,
        command,
        args,
        projectPath: ctx.projectPath,
        options,
      });
    },
  };
}
