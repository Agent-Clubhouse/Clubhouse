import { useState } from 'react';
import type { AnnexDevice } from '../../../shared/types';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useAnnexStore } from '../../stores/annexStore';
import { getAgentColorHex } from '../../../shared/name-generator';
import { Button } from '../../components/Button';
import { settingsInput } from './SettingsLayout';

/**
 * Sets the host name or address a satellite is reached at, such as its tailnet
 * name (#3058). Saving an empty value goes back to found addresses only.
 */
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
          aria-label={`Address for ${device.alias || 'this computer'}`}
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

interface Props {
  /** Devices this machine controls, from the one device list. */
  devices: AnnexDevice[];
  /** Opens the pairing wizard for a satellite whose pairing can't be used any more. */
  onPairAgain?: (device: AnnexDevice) => void;
}

function StatusDot({ device }: { device: AnnexDevice }) {
  if (device.problem?.code === 'incompatible') return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-ctp-error" />;
  const colors: Record<AnnexDevice['state'], string> = {
    connected: 'bg-ctp-success',
    connecting: 'bg-ctp-warning animate-pulse',
    offline: 'bg-surface-2',
    'needs-pairing': 'bg-surface-2',
  };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colors[device.state]}`} />;
}

function stateLabel(device: AnnexDevice): string {
  if (device.problem?.code === 'incompatible') return 'Incompatible';
  switch (device.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'needs-pairing': return 'Needs pairing again';
    case 'offline': return 'Offline';
  }
}

export function PairedSatelliteList({ devices, onPairAgain }: Props) {
  const disconnect = useAnnexClientStore((s) => s.disconnect);
  const retry = useAnnexClientStore((s) => s.retry);
  const removeDevice = useAnnexStore((s) => s.removeDevice);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);

  // Connected first, then alphabetical
  const sorted = [...devices].sort((a, b) => {
    if (a.state === 'connected' && b.state !== 'connected') return -1;
    if (a.state !== 'connected' && b.state === 'connected') return 1;
    return a.alias.localeCompare(b.alias);
  });

  return (
    <div data-testid="paired-satellite-list">
      {sorted.map((device) => (
        <div key={device.fingerprint} className="border-t border-surface-0">
        <div
          data-testid="annex-device-row"
          data-state={device.state}
          className="flex items-center gap-3 min-h-[46px] py-2"
        >
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
                <span>{stateLabel(device)}</span>
                {(device.address || device.typedHost) && (
                  <span className="truncate" data-testid="annex-device-address">
                    {device.address ? `at ${device.address}` : `at ${device.typedHost}`}
                  </span>
                )}
              </div>
              {device.problem && (
                <div className="text-xs text-ctp-overlay1" data-testid="annex-device-problem">
                  {device.problem.message} {device.problem.action}
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-1.5 shrink-0">
            {device.state === 'needs-pairing' && onPairAgain && (
              <Button onClick={() => onPairAgain(device)} kind="ghost">
                Pair again
              </Button>
            )}
            {device.state === 'offline' && (
              <Button onClick={() => retry(device.fingerprint)} kind="ghost">
                Retry
              </Button>
            )}
            {device.state === 'connected' && (
              <Button onClick={() => disconnect(device.fingerprint)} kind="ghost">
                Disconnect
              </Button>
            )}
            {device.role === 'satellite' && device.state !== 'needs-pairing' && editingAddress !== device.fingerprint && (
              <Button onClick={() => setEditingAddress(device.fingerprint)} kind="ghost">
                Address
              </Button>
            )}
            {confirmForget === device.fingerprint ? (
              <>
                <Button onClick={() => setConfirmForget(null)} kind="ghost">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    void removeDevice(device.fingerprint);
                    setConfirmForget(null);
                  }}
                  kind="danger"
                >
                  Confirm
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirmForget(device.fingerprint)} kind="danger">
                Forget
              </Button>
            )}
          </div>
        </div>
        {editingAddress === device.fingerprint && (
          <AddressEditor device={device} onDone={() => setEditingAddress(null)} />
        )}
        </div>
      ))}
    </div>
  );
}
