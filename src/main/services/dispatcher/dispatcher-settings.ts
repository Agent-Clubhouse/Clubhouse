import { createSettingsStore } from '../settings-store';
import * as experimentalSettings from '../experimental-settings';
import { newChromeEnabled, peekNewChromeEnabledForDisplay } from '../../window-chrome';
import { resolveDispatcherEnablement, type DispatcherEnablement } from '../../../shared/dispatcher-types';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';
import type { DispatcherBehavior } from '../../../shared/dispatcher-behavior';
import type { DispatcherModelsBefore, SavedDispatcherModels } from '../../../shared/dispatcher-models';
import type { DispatcherPersonality } from '../../../shared/dispatcher-personality';
import type { DispatcherSetupState } from '../../../shared/dispatcher-setup';
import { readDisplaySettings, displayInput, ownDisplayValue, type DisplayValue, type DisplayReceipt, type DisplayInput } from '../display-settings';
import type { DispatcherOffReason } from '../../../shared/dispatcher-types';

/** A saved experimental flag from before the Dispatcher graduated. Read, never written or offered. */
export const DISPATCHER_FLAG = 'dispatcher';

export interface DispatcherSettings {
  /** The "Turn on Dispatcher" switch on Settings > Dispatcher. Missing means the default. */
  enabled?: boolean;
  /** Behavior (#3045): Light, Standard or Thorough. Missing or unknown reads as Standard. */
  behavior?: DispatcherBehavior;
  /**
   * Choose models yourself (#3191): the switch and each job's pick. Missing
   * or off means Behavior gives the models. The picks stay when it goes off.
   */
  models?: SavedDispatcherModels;
  /** The provider and context its agents ran on when Choose models yourself went on, put back when it goes off. */
  modelsBefore?: DispatcherModelsBefore;
  /** Personality (#3047): the text for its chat's instructions and its preset. Missing reads as Concise. */
  personality?: DispatcherPersonality;
  /**
   * First-run setup (#3047). Missing until the Dispatcher is first turned on
   * in a version that has setup, which saves `pending` and whether it is an upgrade.
   */
  setup?: DispatcherSetupState;
}

const store = createSettingsStore<DispatcherSettings>('dispatcher-settings.json', {}, undefined, { displaySnapshot: true, audit: { key: 'dispatcher' } });

export const getSettings = store.get;
export const updateSettings = store.update;

/** Whether the Dispatcher is on, what its saved values say, and why it is off. */
export function dispatcherEnablement(): DispatcherEnablement {
  const saved: unknown = store.get().enabled;
  return resolveDispatcherEnablement({
    saved: typeof saved === 'boolean' ? saved : undefined,
    graduatedFlagOn: isGraduatedFlagOn(experimentalSettings.getSettings(), DISPATCHER_FLAG),
    newLayout: newChromeEnabled(),
  });
}

/** Everything that shows or wires the Dispatcher gates on this. */
export function isDispatcherEnabled(): boolean {
  return dispatcherEnablement().enabled;
}

/** Selected switch and established session layout only; no generic load, state or request timers. */
export function readDispatcherEnablementForDisplay(options: { receipts?: DisplayReceipt[] } = {}): {
  enabled: DisplayValue<boolean>; reason: DisplayValue<DispatcherOffReason | null>;
} {
  const read = () => {
    const evidence = readDisplaySettings(store, 'dispatcher-settings.json');
    const inputs: DisplayInput[] = [displayInput('Host Dispatcher switch', evidence)];
    const unknown = <T>(): DisplayValue<T> => ({ state: 'unavailable', inputs });
    const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
    const result = (enabled: boolean, reason: DispatcherOffReason | null) => ({ enabled: known(enabled), reason: known(reason) });
    if (evidence.state !== 'ok') return { enabled: unknown<boolean>(), reason: unknown<DispatcherOffReason | null>() };
    const saved = ownDisplayValue(evidence.raw, 'enabled');
    if (saved !== undefined && typeof saved !== 'boolean') return { enabled: unknown<boolean>(), reason: unknown<DispatcherOffReason | null>() };
    // A saved switch wins independently of layout and retired flags. Do not
    // consult unrelated settings when they cannot affect the answer.
    if (typeof saved === 'boolean') return result(saved, saved ? null : 'switch_off');
    const flag = experimentalSettings.readGraduatedFlagForDisplay('dispatcher');
    inputs.push(...flag.inputs);
    if (flag.state === 'ok' && !flag.value) return result(false, 'experimental_off');
    const layout = peekNewChromeEnabledForDisplay();
    inputs.push({ field: 'Established session layout', source: 'host-cache', observedAt: Date.now() });
    // Even with an unknown flag, a known classic session cannot enable the
    // default Dispatcher. Its precise off reason is still unavailable.
    if (flag.state !== 'ok') return { enabled: layout === false ? known(false) : unknown<boolean>(), reason: unknown<DispatcherOffReason | null>() };
    if (layout === undefined) return { enabled: unknown<boolean>(), reason: unknown<DispatcherOffReason | null>() };
    const value = resolveDispatcherEnablement({ saved: undefined, graduatedFlagOn: flag.value, newLayout: layout });
    return result(value.enabled, value.reason);
  };
  const value = read();
  const signature = (value: ReturnType<typeof read>) => JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
    { state: field.state, value: field.state === 'ok' ? field.value : undefined, inputs: field.inputs.map(({ field, source }) => ({ field, source })) }])));
  if (options.receipts) {
    const admitted = signature(value);
    options.receipts.push({ current: () => { try { return signature(read()) === admitted; } catch { return false; } } });
  }
  return value;
}
