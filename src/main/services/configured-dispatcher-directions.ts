/** Pure configured source projection. Caller owns strict selected/controller admission and final receipts. */
import { AUTOMATIC_CONNECTION_SWITCHES } from '../../shared/connection-grants';
import { display } from './remote-details-presentation';
import type { DisplayValue } from './display-settings';
import { hasAsciiControl } from '../../shared/ascii-control';

export interface ConfiguredDispatcherDirection {
  agentId: string;
  targetId: string;
  agentName?: string;
  targetName?: string;
  disabledTools: string[];
  enabledTools: string[];
}
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 200 && !value.includes('@') && !hasAsciiControl(value);
const name = (value: unknown): string | undefined => typeof value === 'string' && !!value && value.length <= 1024 ? display(value, 240) : undefined;

/** These are saved-policy directions, including while Dispatcher is off; never bindings or authority.
 * Unknown controller identity cannot create a direction or prove that none is configured. */
export function configuredDispatcherDirections(selected: { id: string; name?: string }, connect: DisplayValue<boolean>, controller?: { id: string; name?: string }): DisplayValue<ConfiguredDispatcherDirection[]> {
  const inputs = connect.inputs.map((input) => ({ ...input }));
  if (!id(selected.id) || connect.state !== 'ok' || typeof connect.value !== 'boolean') return { state: 'unavailable', reason: 'invalid', inputs };
  if (!connect.value) return { state: 'ok', value: [], inputs };
  if (!controller || !id(controller.id) || controller.id === selected.id) return { state: 'unavailable', inputs };
  const selectedName = name(selected.name), controllerName = name(controller.name);
  const toDispatcher = AUTOMATIC_CONNECTION_SWITCHES.agentToDispatcher, fromDispatcher = AUTOMATIC_CONNECTION_SWITCHES.dispatcherToAgent;
  return { state: 'ok', inputs, value: [
    { agentId: selected.id, targetId: controller.id, agentName: selectedName, targetName: controllerName, disabledTools: [...toDispatcher.disabledTools], enabledTools: [...toDispatcher.enabledTools] },
    { agentId: controller.id, targetId: selected.id, agentName: controllerName, targetName: selectedName, disabledTools: [...fromDispatcher.disabledTools], enabledTools: [...fromDispatcher.enabledTools] },
  ] };
}
