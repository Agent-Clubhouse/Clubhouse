/**
 * The Dispatcher's personality text, for Settings › Dispatcher (#3046): exactly
 * what it's told, added to its instructions as written.
 *
 * SEAM: the field itself, its presets and its IPC belong to first-run setup
 * (#3047). Until that lands, this reads null and the page leaves the
 * Personality field out. Wire #3047's accessor in here and nowhere else; don't
 * add a second field for it.
 */
import type { DispatcherState } from '../../../shared/dispatcher-types';

export interface DispatcherPersonality {
  /** The text it's told, as saved. */
  text: string;
  /** Save new text. Resolves once main has it. */
  save: (text: string) => Promise<void>;
}

/** The personality as main holds it, or null while no personality field exists. */
export function useDispatcherPersonality(_state: DispatcherState | null): DispatcherPersonality | null {
  return null;
}
