import type { PluginContext, LoggingAPI } from '../../shared/plugin-types';
import type { LogLevel } from '../../shared/types';
import { pluginDiagNamespace } from '../../shared/telemetry/diag';
import { rendererLog } from './renderer-logger';

export function createLoggingAPI(ctx: PluginContext): LoggingAPI {
  const ns = pluginDiagNamespace(ctx.pluginId);
  // A cut namespace (#2403) keeps the whole id in meta; the plugin's own meta.pluginId wins.
  const cut = ns !== `plugin:${ctx.pluginId}`;
  const line = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    rendererLog(ns, level, msg, { projectId: ctx.projectId, meta: cut ? { pluginId: ctx.pluginId, ...meta } : meta });
  };
  return {
    debug(msg: string, meta?: Record<string, unknown>): void {
      line('debug', msg, meta);
    },
    info(msg: string, meta?: Record<string, unknown>): void {
      line('info', msg, meta);
    },
    warn(msg: string, meta?: Record<string, unknown>): void {
      line('warn', msg, meta);
    },
    error(msg: string, meta?: Record<string, unknown>): void {
      line('error', msg, meta);
    },
    fatal(msg: string, meta?: Record<string, unknown>): void {
      line('fatal', msg, meta);
    },
  };
}
