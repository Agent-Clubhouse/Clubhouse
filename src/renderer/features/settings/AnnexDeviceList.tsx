import { useState } from 'react';
import type { AnnexDevice } from '../../../shared/types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';
import { getAgentColorHex } from '../../../shared/name-generator';
import { formatAgo } from '../agents/states/format';
import { Button } from '../../components/Button';
import { settingsInput } from './SettingsLayout';

/**
 * Every paired device, whichever way it's paired (#3067): the one list the
 * Annex Network page shows, with what can be done to each.
 */

/** This machine connects to it: a satellite, or a computer in its network. */
function connectsTo(device: AnnexDevice): boolean {
  return device.role === 'satellite' || (device.role === 'member' && device.kind !== 'phone');
}

/** Pairs again from here: a computer this machine connects to, or an older entry with no role. */
function pairsAgainFromHere(device: AnnexDevice): boolean {
  return connectsTo(device) || (!device.role && device.kind !== 'phone');
}

/** How the device relates to this machine, in a few words. */
function relation(device: AnnexDevice): string {
  if (device.role === 'member') return device.kind === 'phone' ? 'Phone in this network' : 'In this network';
  if (device.role === 'satellite') return 'Paired one-to-one, and this computer controls it';
  if (device.role === 'controller') return 'Paired one-to-one, and it controls this computer';
  return 'Paired with an older version';
}

function stateLabel(device: AnnexDevice, now: number): string {
  if (device.problem?.code === 'incompatible') return 'Incompatible';
  switch (device.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'needs-pairing': return 'Needs pairing again';
    case 'removing': return 'Removing';
    case 'offline': {
      const seen = device.lastSeen ? Date.parse(device.lastSeen) : NaN;
      return Number.isNaN(seen) ? 'Offline' : `Offline, last seen ${formatAgo(seen, now)}`;
    }
  }
}

function StatusDot({ device }: { device: AnnexDevice }) {
  if (device.problem?.code === 'incompatible') return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-ctp-error" />;
  const colors: Record<AnnexDevice['state'], string> = {
    connected: 'bg-ctp-success',
    connecting: 'bg-ctp-warning animate-pulse',
    offline: 'bg-surface-2',
    'needs-pairing': 'bg-surface-2',
    removing: 'bg-ctp-warning',
  };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[device.state]}`} />;
}

/** Where a network join or removal has reached, as one sentence each way (#3061). */
function confirmationText(confirmation: NonNullable<AnnexDevice['confirmation']>): string {
  const list = (names: string[]) => names.join(', ');
  const done = confirmation.confirmedBy.length > 0 ? `Confirmed on ${list(confirmation.confirmedBy)}.` : 'Not confirmed on any other device yet.';
  const waiting = confirmation.waitingOn.length > 0
    ? ` Waiting for ${list(confirmation.waitingOn)}, which ${confirmation.waitingOn.length === 1 ? 'hears' : 'hear'} when next connected.`
    : '';
  return `${done}${waiting}`;
}

/** Sets the host name or address a device is reached at, such as its tailnet name (#3058). */
function AddressEditor({ device, onDone }: { device: AnnexDevice; onDone: () => void }) {
  const [value, setValue] = useState(device.typedHost ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const result = await window.clubhouse.annexClient.setSatelliteHost(device.fingerprint, value);
    if ('error' in result) setError(result.error);
    else onDone();
  };
  return (
    <div className="flex flex-col gap-1 pb-2" data-testid="annex-address-editor">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          aria-label={`Address for ${device.alias || 'this device'}`}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          className={`${settingsInput} w-[260px]`}
          placeholder="studio.tailnet.ts.net"
        />
        <Button onClick={() => void save()} kind="primary">Save</Button>
        <Button onClick={onDone} kind="ghost">Cancel</Button>
      </div>
      <div className={`text-xs ${error ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>
        {error ?? 'A name or address it can be reached at, such as its tailnet name. Tried along with addresses found on the network.'}
      </div>
    </div>
  );
}

/** Renames a network member, everywhere. */
function RenameEditor({ device, onDone }: { device: AnnexDevice; onDone: () => void }) {
  const [value, setValue] = useState(device.alias);
  const [failed, setFailed] = useState(false);
  const rename = useAnnexStore((s) => s.renameDevice);
  const save = async (): Promise<void> => {
    const name = value.trim();
    if (!name || name === device.alias) { onDone(); return; }
    if (await rename(device.fingerprint, name)) onDone();
    else setFailed(true);
  };
  return (
    <div className="flex flex-col gap-1 pb-2" data-testid="annex-rename-editor">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          aria-label={`Name for ${device.alias || 'this device'}`}
          value={value}
          maxLength={200}
          onChange={(e) => { setValue(e.target.value); setFailed(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          className={`${settingsInput} w-[260px]`}
        />
        <Button onClick={() => void save()} kind="primary">Save</Button>
        <Button onClick={onDone} kind="ghost">Cancel</Button>
      </div>
      {failed && <div className="text-xs text-ctp-error">Couldn&apos;t rename it. It may have left the network.</div>}
    </div>
  );
}

interface Props {
  devices: AnnexDevice[];
  /** Whether this machine connects to other computers now; Reconnect is offered only then. */
  canConnect?: boolean;
  /** Opens the pairing wizard for a device whose pairing can't be used any more. */
  onPairAgain?: (device: AnnexDevice) => void;
}

export function AnnexDeviceList({ devices, canConnect = true, onPairAgain }: Props) {
  const disconnect = useAnnexClientStore((s) => s.disconnect);
  const retry = useAnnexClientStore((s) => s.retry);
  const removeDevice = useAnnexStore((s) => s.removeDevice);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ fingerprint: string; what: 'address' | 'name' } | null>(null);
  const now = Date.now();

  // Connected first, then by name.
  const sorted = [...devices].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <div data-testid="annex-device-list">
      {sorted.map((device) => {
        const removing = device.state === 'removing';
        const isEditing = (what: 'address' | 'name') => editing?.fingerprint === device.fingerprint && editing.what === what;
        return (
          <div key={device.fingerprint} className="border-t border-surface-0">
            <div data-testid="annex-device-row" data-state={device.state} data-role={device.role ?? 'none'} className="flex items-center gap-3 min-h-[46px] py-2">
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <div
                  className="w-[18px] h-[18px] rounded flex items-center justify-center text-xs font-bold leading-none shrink-0"
                  style={{ backgroundColor: `${getAgentColorHex(device.color)}33`, color: getAgentColorHex(device.color) }}
                  aria-hidden="true"
                >
                  {(device.alias || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] text-ctp-text truncate">{device.alias || 'Unnamed device'}</div>
                  <div className="flex items-center gap-1.5 text-xs text-ctp-overlay1 min-w-0">
                    <StatusDot device={device} />
                    <span>{stateLabel(device, now)}</span>
                    {(device.address || device.typedHost) && <span className="truncate" data-testid="annex-device-address">at {device.address || device.typedHost}</span>}
                  </div>
                  <div className="text-xs text-ctp-overlay1">{relation(device)}{device.sessionOnly ? ', this session only' : ''}</div>
                  {device.problem && device.state !== 'connected' && (
                    <div className="text-xs text-ctp-overlay1" data-testid="annex-device-problem">
                      {device.problem.message} {device.problem.action}
                    </div>
                  )}
                  {device.confirmation && (
                    <div className="text-xs text-ctp-overlay1" data-testid="annex-device-confirmation">{confirmationText(device.confirmation)}</div>
                  )}
                </div>
              </div>

              {!removing && (
                <div className="flex gap-1.5 shrink-0">
                  {device.state === 'needs-pairing' && pairsAgainFromHere(device) && onPairAgain && (
                    <Button onClick={() => onPairAgain(device)} kind="ghost">Pair again</Button>
                  )}
                  {device.state === 'offline' && connectsTo(device) && canConnect && (
                    <Button onClick={() => retry(device.fingerprint)} kind="ghost">Reconnect</Button>
                  )}
                  {/* A member may be connected from its side too, so only a satellite's connection is this machine's to end. */}
                  {device.state === 'connected' && device.role === 'satellite' && (
                    <Button onClick={() => disconnect(device.fingerprint)} kind="ghost">Disconnect</Button>
                  )}
                  {device.role === 'member' && !isEditing('name') && (
                    <Button onClick={() => setEditing({ fingerprint: device.fingerprint, what: 'name' })} kind="ghost">Rename</Button>
                  )}
                  {connectsTo(device) && !isEditing('address') && (
                    <Button onClick={() => setEditing({ fingerprint: device.fingerprint, what: 'address' })} kind="ghost">Address</Button>
                  )}
                  {confirmRemove === device.fingerprint ? (
                    <>
                      <Button onClick={() => setConfirmRemove(null)} kind="ghost">Cancel</Button>
                      <Button onClick={() => { void removeDevice(device.fingerprint); setConfirmRemove(null); }} kind="danger">Confirm</Button>
                    </>
                  ) : (
                    <Button onClick={() => setConfirmRemove(device.fingerprint)} kind="danger">Remove</Button>
                  )}
                </div>
              )}
            </div>
            {confirmRemove === device.fingerprint && (
              <div className="text-xs text-ctp-overlay1 pb-2">
                {device.role === 'member'
                  ? 'It will be removed from every device in this network, and the devices that are off hear when they next connect.'
                  : 'Its pairing with this computer ends, and it will need to pair again.'}
              </div>
            )}
            {isEditing('address') && <AddressEditor device={device} onDone={() => setEditing(null)} />}
            {isEditing('name') && <RenameEditor device={device} onDone={() => setEditing(null)} />}
          </div>
        );
      })}
    </div>
  );
}
