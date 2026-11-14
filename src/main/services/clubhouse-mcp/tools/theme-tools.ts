import { BUILTIN_THEMES } from '../../../../renderer/themes';
import { IPC } from '../../../../shared/ipc-channels';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { themeChanged } from '../../../telemetry/feature-events';
import { getPluginThemes } from '../../plugin-theme-store';
import * as themeService from '../../theme-service';
import { askFirst } from '../ask-first';
import { checkToolGrant } from '../grant-check';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';

const GRANT = { actions: ['settings.app.write'], target: 'app' } as const;
const text = (message: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: message }], ...(isError && { isError: true }) });

function installedIds(): string[] {
  return [...new Set([...Object.keys(BUILTIN_THEMES), ...getPluginThemes().map((theme) => theme.id)])].sort();
}

export function registerThemeTools(): void {
  registerGlobalTool('set_theme', {
    description: 'Set the app theme to an installed theme id. An Ask first settings.app.write grant records the exact call in Needs you; retry with the same arguments after approval. An unknown id returns the valid installed ids.',
    inputSchema: { type: 'object', properties: { theme_id: { type: 'string', description: 'Installed built-in, plugin or custom theme id.' } }, required: ['theme_id'] },
  }, async (agentId, args) => {
    try {
      const themeId = args.theme_id;
      const validate = () => {
        const ids = installedIds();
        if (Object.keys(args).some((key) => key !== 'theme_id') || typeof themeId !== 'string' || !ids.includes(themeId)) {
          throw new Error(`Give theme_id as an installed theme id. Valid ids: ${ids.join(', ')}.`);
        }
      };
      validate();
      const check = checkToolGrant(agentId, GRANT, args);
      if (check.ok === false) {
        if (check.reason !== 'ask_first') return text(check.message, true);
        const approval = await askFirst(agentId, 'set_theme', args, check.asks);
        if (approval.kind === 'asked') return text(approval.text);
      }
      const assertAuthorized = () => {
        validate();
        const current = checkToolGrant(agentId, { ...GRANT, askHandledByTool: true }, args);
        if (current.ok === false) throw new Error(current.message);
      };
      assertAuthorized();
      await themeService.saveSettings({ themeId: themeId as string }, { prepare: async () => {}, check: assertAuthorized });
      themeChanged(themeId as string);
      broadcastToAllWindows(IPC.APP.THEME_CHANGED);
      const annex = await import('../../annex-server');
      annex.broadcastThemeChanged();
      return text(JSON.stringify({ theme_id: themeId }));
    } catch (err) {
      // telemetry-exempt: the refusal is logged and returned to the caller.
      const message = err instanceof Error ? err.message : String(err);
      appLog('core:mcp', 'warn', 'set_theme failed or was refused', { meta: { agentId, error: message } });
      return text(message, true);
    }
  }, { grant: { ...GRANT, askHandledByTool: true } });
}
