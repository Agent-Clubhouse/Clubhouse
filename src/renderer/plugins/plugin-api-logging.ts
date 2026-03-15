import type { PluginContext, LoggingAPI } from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';

export function createLoggingAPI(ctx: PluginContext): LoggingAPI {
  const ns = `plugin:${ctx.pluginId}`;
  return {
    debug(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'debug', msg, { projectId: ctx.projectId, meta });
    },
    info(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'info', msg, { projectId: ctx.projectId, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'warn', msg, { projectId: ctx.projectId, meta });
    },
    error(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'error', msg, { projectId: ctx.projectId, meta });
    },
    fatal(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'fatal', msg, { projectId: ctx.projectId, meta });
    },
  };
}
