import { registerGlobalTool } from '../tool-registry';
import { requestAppUpdate } from '../../app-update-request';
import { appLog } from '../../log-service';
import { MobileControlError } from '../../mobile-control';

export function registerAppUpdateTools(): void {
  registerGlobalTool('request_app_update', {
    description: 'Ask the person to approve installing the ready Clubhouse update. They choose Restart now, Restart when idle, or Cancel in Needs you. This call never approves or applies an update, even with an Allow grant. Do not retry to install it.',
    inputSchema: { type: 'object', properties: {} },
  }, async (_agentId, args) => {
    if (Object.keys(args).length) return { content: [{ type: 'text', text: 'This tool takes no arguments.' }], isError: true };
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await requestAppUpdate()) }] };
    } catch (err) {
      // telemetry-exempt: refusal is logged below and returned as a visible tool error.
      const message = err instanceof Error ? err.message : String(err);
      appLog('core:mcp', 'warn', 'Update request refused', { meta: { reason: message } });
      return { content: [{ type: 'text', text: err instanceof MobileControlError ? err.detail ?? err.code : 'The update request could not be prepared. Try again on the desktop.' }], isError: true };
    }
  }, { group: 'dispatcher', grant: { actions: ['app.update'], target: 'app', askHandledByTool: true } });
}
