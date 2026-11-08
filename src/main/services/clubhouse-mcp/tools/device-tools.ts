/**
 * See devices and Manage devices (#3068): the Annex Network's devices, for
 * agents with a grant (by default the Dispatcher: See devices allowed, Manage
 * devices asking first). Each acts on this machine's own view of its devices;
 * another machine's are its own to manage.
 *
 * No tool finishes a pairing. Starting one only opens Settings › Annex
 * Network on this computer, where a person adds the device; no code, link or
 * certificate reaches the agent.
 */

import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import type { AnnexDevice } from '../../../../shared/types';
import { appLog } from '../../log-service';
import { requireString } from './validation';
import { describeCallsForAsk } from '../ask-first';

/** What the tools act through; set at startup (main's Annex services), tests set fakes. */
export interface DeviceToolHost {
  list(): AnnexDevice[];
  rename(fingerprint: string, name: string): boolean | Promise<boolean>;
  reconnect(fingerprint: string): void;
  remove(fingerprint: string): boolean;
  /** Opens Settings › Annex Network on this computer for the person. False when no window is open. */
  openAddDevice(): boolean;
  /** Whether this computer connects to other computers now (Annex Network on, or Connect to satellites). */
  canConnect(): boolean;
}

let host: DeviceToolHost | null = null;

export function setDeviceToolHost(next: DeviceToolHost | null): void {
  host = next;
}

function text(message: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError && { isError: true }) };
}

/** How a device relates to this computer, in a word. */
function relation(d: AnnexDevice): string {
  if (d.role === 'member') return 'network';
  if (d.role === 'satellite') return 'controlled_from_here';
  if (d.role === 'controller') return 'controls_this_computer';
  return 'needs_pairing';
}

/** A device as an agent sees it: its name and whether it's online, and nothing that pairs or reaches it. */
export function deviceForAgent(d: AnnexDevice): Record<string, unknown> {
  return {
    id: d.fingerprint,
    name: d.alias || 'Unnamed device',
    kind: d.kind ?? (d.role === 'controller' || d.role === 'member' ? 'unknown' : 'desktop'),
    online: d.state === 'connected',
    state: d.state,
    relation: relation(d),
  };
}

function find(fingerprint: string): AnnexDevice | undefined {
  const fp = fingerprint.toLowerCase();
  return host?.list().find((d) => d.fingerprint.toLowerCase() === fp);
}

const NOT_FOUND = 'No device with that id is paired with this computer. list_devices lists them.';

/** The device a call names, for the person asked to allow it: by name, never only by id. */
function describeDevice(action: string) {
  return (args: Record<string, unknown>): string | undefined => {
    const device = typeof args.id === 'string' ? find(args.id) : undefined;
    if (!device) return `${action} a device this computer doesn't know.`;
    const kind = device.kind === 'phone' ? 'phone' : 'computer';
    return `${action} ${device.alias || 'an unnamed device'} (${kind}, ${device.role === 'member' ? 'in this network' : 'paired one-to-one'}).`;
  };
}

export function registerDeviceTools(): void {
  describeCallsForAsk('rename_device', (args) => {
    const line = describeDevice('Rename')(args);
    return typeof args.name === 'string' ? `${line?.replace(/\.$/, '')} to "${args.name.trim()}".` : line;
  });
  describeCallsForAsk('reconnect_device', describeDevice('Reconnect to'));
  describeCallsForAsk('remove_device', (args) => {
    const line = describeDevice('Remove')(args);
    return `${line} A device in the network goes from every device in it, and comes back only when a person pairs it again.`;
  });

  registerGlobalTool(
    'list_devices',
    {
      description: 'List the devices in this computer\'s Annex Network and the ones paired with it: each one\'s id, name, kind and whether it is online.',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => {
      if (!host) return text('Annex Network is not available.', true);
      return text(JSON.stringify(host.list().map(deviceForAgent)));
    },
    { grant: { actions: ['device.read'], target: 'app' } },
  );

  registerGlobalTool(
    'rename_device',
    {
      description: 'Rename a computer or phone in the Annex Network. The new name shows on every device in it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The device id from list_devices.' },
          name: { type: 'string', description: 'The new name, up to 200 characters.' },
        },
        required: ['id', 'name'],
      },
    },
    async (agentId, args) => {
      const id = requireString(args, 'id');
      const name = requireString(args, 'name')?.trim();
      if (!id || !name || name.length > 200) return text('Give the device id and a name of 1 to 200 characters.', true);
      const device = find(id);
      if (!host || !device) return text(NOT_FOUND, true);
      if (device.role !== 'member') return text('Only a device in the network can be renamed; one paired one-to-one keeps its own name.', true);
      const ok = await host.rename(device.fingerprint, name);
      appLog('core:annex', 'info', 'An agent renamed a device', { meta: { agentId, ok } });
      return ok ? text(`Renamed it to ${name}.`) : text('It could not be renamed. It may have left the network.', true);
    },
    { grant: { actions: ['device.manage'], target: 'app' } },
  );

  registerGlobalTool(
    'reconnect_device',
    {
      description: 'Try connecting to a computer this one connects to, now, instead of waiting for the next try.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The device id from list_devices.' } }, required: ['id'] },
    },
    async (agentId, args) => {
      const id = requireString(args, 'id');
      const device = id ? find(id) : undefined;
      if (!host || !device) return text(NOT_FOUND, true);
      const connectsFromHere = device.role === 'satellite' || (device.role === 'member' && device.kind !== 'phone');
      if (!connectsFromHere) return text('This computer doesn\'t connect to that device; it connects here when it\'s on.', true);
      if (device.state === 'needs-pairing') return text('That device needs pairing again, which a person does in Settings.', true);
      if (device.state === 'removing') return text('That device is being removed.', true);
      // Off means off: the person turned connecting to other computers off here.
      if (!host.canConnect()) return text('This computer isn\'t connecting to other computers now. A person turns that on in Settings > Annex Network.', true);
      host.reconnect(device.fingerprint);
      appLog('core:annex', 'info', 'An agent asked to reconnect a device', { meta: { agentId } });
      return text(device.state === 'connected' ? 'It is already connected.' : 'Trying to connect now.');
    },
    { grant: { actions: ['device.manage'], target: 'app' } },
  );

  registerGlobalTool(
    'remove_device',
    {
      description: 'Remove a device. One in the network is removed from every device in it, and the ones that are off hear when they next connect. It has to be paired again to come back.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The device id from list_devices.' } }, required: ['id'] },
    },
    async (agentId, args) => {
      const id = requireString(args, 'id');
      const device = id ? find(id) : undefined;
      if (!host || !device) return text(NOT_FOUND, true);
      if (device.state === 'removing') return text('It is already being removed.');
      const removed = host.remove(device.fingerprint);
      appLog('core:annex', 'info', 'An agent removed a device', { meta: { agentId, removed } });
      return removed ? text(`Removed ${device.alias || 'it'}.`) : text('It could not be removed.', true);
    },
    { grant: { actions: ['device.manage'], target: 'app' } },
  );

  registerGlobalTool(
    'start_adding_device',
    {
      description:
        'Open Settings > Annex Network on this computer so a person can add a computer or phone. ' +
        'Only a person at the new device can finish pairing: you get no code, link or certificate.',
      inputSchema: { type: 'object', properties: {} },
    },
    async (agentId) => {
      if (!host) return text('Annex Network is not available.', true);
      const opened = host.openAddDevice();
      appLog('core:annex', 'info', 'An agent opened Add a device', { meta: { agentId, opened } });
      return opened
        ? text('Opened Settings > Annex Network on this computer. A person at the new device finishes the pairing there.')
        : text('Clubhouse has no window open on this computer to show it in.', true);
    },
    { grant: { actions: ['device.manage'], target: 'app' } },
  );
}
