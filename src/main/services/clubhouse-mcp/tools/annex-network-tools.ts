import type { AnnexNetworkSettingsState } from '../../../../shared/annex-network-settings';
import { getSettings, networkEnabled } from '../../annex-settings';
import { annexNetworkProfile } from '../../annex-network-profile';
import { deliveryHash } from '../../annex-delivery-store';
import { appLog } from '../../log-service';
import { appendSettingsAudit } from '../../settings-audit';
import { askFirst, describeCallsForAsk } from '../ask-first';
import { checkToolGrant } from '../grant-check';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';

export interface AnnexNetworkToolHost {
  /** Applies a saved loopback change to the live server and discovery. */
  applyLoopbackOnly(value: boolean, assertAuthorized: () => void): Promise<void>;
}

let host: AnnexNetworkToolHost | undefined;
let writes: Promise<unknown> = Promise.resolve();
export function setAnnexNetworkToolHost(next: AnnexNetworkToolHost | undefined): void { host = next; }

export function readAnnexNetworkSettings(env: NodeJS.ProcessEnv = process.env): AnnexNetworkSettingsState {
  const saved = getSettings();
  const profile = annexNetworkProfile(env, saved.loopbackOnly);
  const state: Omit<AnnexNetworkSettingsState, 'expected_state'> = {
    server_enabled: !!saved.enableServer,
    client_enabled: !!saved.enableClient,
    network_enabled: networkEnabled(saved),
    loopback_only: !!saved.loopbackOnly,
    effective_scope: profile.host === '127.0.0.1' ? 'loopback' : profile.host === '0.0.0.0' ? 'network' : 'selected_interface',
    discovery_enabled: profile.advertise && (!!saved.enableClient || !!saved.enableServer),
    process_restricted: env.CLUBHOUSE_ANNEX_LOOPBACK_ONLY === '1' || !!env.CLUBHOUSE_ANNEX_BIND_ADDRESS,
  };
  return { ...state, expected_state: deliveryHash(state) };
}

const text = (message: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: message }], ...(isError && { isError: true }) });
const WRITE_GRANT = { actions: ['settings.app.write'], target: 'app', askHandledByTool: true } as const;

function assertGrant(agentId: string, args: Record<string, unknown>): void {
  const check = checkToolGrant(agentId, WRITE_GRANT, args);
  if (check.ok === false) throw new Error(check.message);
}

export function registerAnnexNetworkTools(): void {
  describeCallsForAsk('update_annex_network_settings', (args) => args.loopback_only === false
    ? 'Allow Annex to listen beyond this computer. This expands network exposure and permits local discovery when enabled. No devices are paired by this change.'
    : 'Restrict Annex to this computer only and disable local discovery. Existing remote connections may be interrupted.');
  registerGlobalTool('get_annex_network_settings', {
    description: 'Read Annex Network switches, effective listener scope and discovery policy. No addresses, ports, devices, PINs or secrets. Use expected_state when requesting a change.',
    inputSchema: { type: 'object', properties: {} },
  }, async (_agentId, args) => {
    if (Object.keys(args).length) return text('This tool takes no arguments.', true);
    try { return text(JSON.stringify(readAnnexNetworkSettings())); }
    catch (err) {
      appLog('core:annex', 'warn', 'Could not read Annex Network settings', { meta: { error: err instanceof Error ? err.message : String(err) } });
      return text('The Annex Network profile is invalid or unavailable. No settings state can be confirmed.', true);
    }
  }, { grant: { actions: ['settings.app.read'], target: 'app' } });

  registerGlobalTool('update_annex_network_settings', {
    description: 'Request a loopback-only change. Every change needs explicit approval of these exact arguments, even with an Allow grant. Expanding exposure is sensitive. Never pairs devices or weakens an isolated process profile.',
    inputSchema: { type: 'object', properties: {
      loopback_only: { type: 'boolean' },
      expected_state: { type: 'string', description: 'From get_annex_network_settings; prevents stale approvals.' },
      reason: { type: 'string', description: 'Why this change is needed; shown to the person approving it.' },
    }, required: ['loopback_only', 'expected_state', 'reason'] },
  }, async (agentId, args) => {
    if (Object.keys(args).some((k) => !['loopback_only', 'expected_state', 'reason'].includes(k))
      || typeof args.loopback_only !== 'boolean' || typeof args.expected_state !== 'string' || !/^[a-f0-9]{64}$/.test(args.expected_state)
      || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000) return text('Give only loopback_only (boolean), expected_state from the read, and a reason of 1 to 1000 characters.', true);
    const loopbackOnly = args.loopback_only;
    const run = async (): Promise<McpToolResult> => {
      try {
        assertGrant(agentId, args);
        const current = readAnnexNetworkSettings();
        if (current.expected_state !== args.expected_state) return text('Annex Network settings changed. Read them again and request approval for the new state.', true);
        if (current.loopback_only === args.loopback_only) return text(JSON.stringify({ changed: false, settings: current }));
        if (current.process_restricted && args.loopback_only === false) return text('This process has an isolated network profile. MCP cannot broaden it; restart with a user-approved profile instead.', true);
        if (!host) throw new Error('Annex Network settings are not available.');
        const approval = await askFirst(agentId, 'update_annex_network_settings', args, [{ action: 'settings.app.write', where: 'Annex Network settings (sensitive network scope)' }]);
        if (approval.kind === 'asked') return text(approval.text);
        assertGrant(agentId, args);
        if (readAnnexNetworkSettings().expected_state !== args.expected_state) return text('Annex Network settings changed while approval was pending. Read and approve the new state.', true);
        await host.applyLoopbackOnly(loopbackOnly, () => {
          assertGrant(agentId, args);
          if (readAnnexNetworkSettings().expected_state !== args.expected_state) throw new Error('Annex Network settings changed before the write.');
        });
        return text(JSON.stringify({ changed: true, settings: readAnnexNetworkSettings() }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appLog('core:annex', 'warn', 'An Annex Network settings change failed or was refused', { meta: { agentId, error: message } });
        await appendSettingsAudit({ surface: 'mcp', actorId: agentId, scope: 'app', key: 'annex.loopbackOnly', outcome: 'refused', code: 'network_change_refused' });
        return text(message, true);
      }
    };
    const pending = writes.then(run, run);
    writes = pending;
    return pending;
  }, { grant: WRITE_GRANT });
}
