import { useEffect, useState } from 'react';
import { useAnnexStore, subscribeAnnexDevices } from '../../stores/annexStore';
import type { AnnexDevice } from '../../../shared/types';
import { getAgentColorHex } from '../../../shared/name-generator';
import { formatAgo } from '../agents/states/format';
import { SettingsSection } from './SettingsLayout';
import { Button } from '../../components/Button';

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function describePeer(peer: AnnexDevice, now: number): string {
  const parts: string[] = [];
  const pairedAt = parseTime(peer.pairedAt);
  const lastSeen = parseTime(peer.lastSeen);
  if (pairedAt !== null) parts.push(`Paired ${new Date(pairedAt).toLocaleDateString()}`);
  if (peer.state === 'connected') parts.push('Connected');
  else if (lastSeen !== null) parts.push(`Last seen ${formatAgo(lastSeen, now)}`);
  if (peer.sessionOnly) parts.push('This session only');
  return parts.join(' · ');
}

/**
 * Phones and computers that can control this machine. Satellites this machine
 * controls are listed in Annex control instead.
 */
export function AnnexPairedDevices({ showWhenEmpty = true }: { showWhenEmpty?: boolean }) {
  const allDevices = useAnnexStore((s) => s.devices);
  const loadDevices = useAnnexStore((s) => s.loadDevices);
  const removeDevice = useAnnexStore((s) => s.removeDevice);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    loadDevices();
    return subscribeAnnexDevices();
  }, [loadDevices]);

  const devices = allDevices
    // Devices that control this machine: controllers, older entries, and phones in its network.
    .filter((d) => d.role === 'controller' || d.role === null || (d.role === 'member' && d.kind === 'phone'))
    .sort((a, b) => a.alias.localeCompare(b.alias));
  const now = Date.now();
  if (devices.length === 0 && !showWhenEmpty) return null;

  return (
    <SettingsSection title="Paired devices" meta={devices.length > 0 ? String(devices.length) : undefined}>
      {devices.length === 0 ? (
        <p className="text-xs text-ctp-overlay1 py-3 border-t border-surface-0">
          No devices paired yet.
        </p>
      ) : (
        <div data-testid="annex-paired-devices">
          {devices.map((peer) => (
            <div
              key={peer.fingerprint}
              data-testid="annex-device-row"
              data-state={peer.state}
              className="flex items-center gap-3 min-h-[46px] py-2 border-t border-surface-0"
            >
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <div
                  className="w-[18px] h-[18px] rounded flex items-center justify-center text-xs font-bold leading-none shrink-0"
                  style={{ backgroundColor: `${getAgentColorHex(peer.color)}33`, color: getAgentColorHex(peer.color) }}
                  aria-hidden="true"
                >
                  {(peer.alias || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] text-ctp-text truncate">{peer.alias || 'Unnamed device'}</div>
                  <div className="text-xs text-ctp-overlay1 truncate">{describePeer(peer, now)}</div>
                  {peer.state === 'needs-pairing' && (
                    <div className="text-xs text-ctp-overlay1">Needs pairing again</div>
                  )}
                </div>
              </div>

              <div className="flex gap-1.5 shrink-0">
                {confirmRemove === peer.fingerprint ? (
                  <>
                    <Button onClick={() => setConfirmRemove(null)} kind="ghost">
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        void removeDevice(peer.fingerprint);
                        setConfirmRemove(null);
                      }}
                      kind="danger"
                    >
                      Confirm
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setConfirmRemove(peer.fingerprint)} kind="danger">
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
