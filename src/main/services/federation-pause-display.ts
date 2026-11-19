/** Selected request-service pause metadata. Never admits work or decides transport authority. */
import { createHash } from 'crypto';
import type { DisplayInput, DisplayValue, DisplayReceipt } from './display-settings';
import type { HelperRequestDisplayText } from './helper-start-requests';
import { redactChangeText } from './read-only-display-text';
import { display } from './remote-details-presentation';

export interface PairingDisplayMatcher { matches(reference: unknown): boolean | undefined }
export interface RequestPauseDisplay {
  /** A nonempty pause in the established request-service view; not permission to act. */
  recorded: boolean;
  reason: HelperRequestDisplayText | null;
  scope: 'none' | 'all-pairings' | 'pairing' | 'unavailable';
  appliesToEpoch(own: PairingDisplayMatcher, peer: PairingDisplayMatcher): boolean | undefined;
}
/** Internal sanitized frame only; raw store/requests/reason/epoch never enter a receipt. */
export interface RequestPauseDisplayFrame {
  recorded: boolean;
  reason: HelperRequestDisplayText | null;
  scope: RequestPauseDisplay['scope'];
  sender?: string;
  receiver?: string;
  key: string;
}
export type RequestPauseDisplayReader = (machine: string, options: { receipts: DisplayReceipt[] }) => DisplayValue<RequestPauseDisplay>;
export const PAUSE_DISPLAY_SCAN_TEXT = 64 * 1024;
const pairingId = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && (value === 'legacy' || /^[A-Za-z0-9-]{8,64}$/.test(value));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function projectRequestPauseForDisplay(rawReason: unknown, rawEpoch: unknown, epochUnavailable = false): RequestPauseDisplayFrame | undefined {
  if (rawReason !== undefined && typeof rawReason !== 'string') return undefined;
  const recorded = !!rawReason;
  let reason: HelperRequestDisplayText | null = null, reasonKey = 'none';
  if (recorded && typeof rawReason === 'string') {
    // Length admission precedes trim, policy scan and hashing. Oversized text
    // attests only its withheld type/length, not its complete hidden contents.
    if (rawReason.length > PAUSE_DISPLAY_SCAN_TEXT) { reason = { state: 'withheld', reason: 'read-limit' }; reasonKey = `over-limit:${rawReason.length}`; }
    else {
      reasonKey = createHash('sha256').update(rawReason).digest('hex');
      const text = rawReason.trim(), safe = text ? redactChangeText(text) : null;
      reason = safe === null ? { state: 'withheld', reason: text ? 'safety' : 'unavailable' }
        : { state: 'ok', text: display(safe, 2048), truncated: safe.length > 2048 };
    }
  }
  let scope: RequestPauseDisplay['scope'] = recorded ? epochUnavailable ? 'unavailable' : rawEpoch === undefined ? 'all-pairings' : 'unavailable' : 'none';
  let sender: string | undefined, receiver: string | undefined;
  if (recorded && !epochUnavailable && record(rawEpoch)) {
    let count = 0, valid = true;
    // Inspect at most the two expected enumerable keys plus a refusal sentinel.
    // No universal engine key-materialization/heap bound is asserted for warm objects.
    for (const key in rawEpoch) { if (++count > 2 || !Object.prototype.hasOwnProperty.call(rawEpoch, key) || key !== 'sender' && key !== 'receiver') { valid = false; break; } }
    if (valid && count === 2 && pairingId(rawEpoch.sender) && pairingId(rawEpoch.receiver)) {
      sender = rawEpoch.sender; receiver = rawEpoch.receiver; scope = 'pairing';
    }
  }
  const key = JSON.stringify({ recorded, reasonKey, scope, sender, receiver });
  return { recorded, reason, scope, ...(sender !== undefined && { sender }), ...(receiver !== undefined && { receiver }), key };
}

/** Separate factory scope retains only selected bounded metadata and a current
 * owner accessor. No admitted raw store, request array, caller/options or epoch object. */
function pauseObservation(machine: string, read: (machine: string) => RequestPauseDisplayFrame | undefined,
  frame: RequestPauseDisplayFrame | undefined): { value: DisplayValue<RequestPauseDisplay>; receipt: DisplayReceipt } {
  const key = frame?.key, recorded = frame?.recorded, scope = frame?.scope, sender = frame?.sender, receiver = frame?.receiver;
  const receipt = { current: () => { try { return read(machine)?.key === key; } catch { return false; } } };
  const inputs: DisplayInput[] = [{ field: 'Established request-service pause metadata', source: 'host-cache', observedAt: Date.now() }];
  if (!frame) return { value: { state: 'unavailable', inputs }, receipt };
  const reason = frame.reason ? { ...frame.reason } : null;
  return { receipt, value: { state: 'ok', inputs, value: { recorded: recorded!, scope: scope!, reason,
    appliesToEpoch(own, peer) {
      if (!receipt.current()) return undefined;
      if (!recorded) return false;
      if (scope === 'all-pairings') return true;
      if (scope !== 'pairing') return undefined;
      const local = own.matches(sender), remote = peer.matches(receiver);
      if (!receipt.current()) return undefined;
      return local === false || remote === false ? false : local === true && remote === true ? true : undefined;
    },
  } } };
}
export function createRequestPauseDisplayReader(read: (machine: string) => RequestPauseDisplayFrame | undefined): RequestPauseDisplayReader {
  return (machine, options) => {
    if (typeof machine !== 'string' || !machine || machine.length > 200) return { state: 'unavailable', reason: 'invalid', inputs: [{ field: 'Selected request-service pause metadata', source: 'host-cache', observedAt: Date.now() }] };
    const observed = pauseObservation(machine, read, read(machine)); options.receipts.push(observed.receipt); return observed.value;
  };
}
