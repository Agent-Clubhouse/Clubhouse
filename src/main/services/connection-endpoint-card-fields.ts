/** Pure presentation of already-admitted endpoint facts; no reads or authority decisions. */
import type { SavedDispatcherEndpointMetadataRow } from './dispatcher-endpoint-associations-display';
import type { ConnectionEndpointFields } from './connection-endpoint-fields-display';
import type { DisplayValue } from './display-settings';
import { display } from './remote-details-presentation';

export interface EndpointCardFields { primaryAdmitted?: true; savedName?: string; displayName?: string; nameOrigin?: 'saved' | 'host-memory'; saved: string; memory?: string }
const known = <T>(field: DisplayValue<T>): T | undefined => field.state === 'ok' ? field.value : undefined;
const name = (fields: ConnectionEndpointFields): string | undefined => {
  const value = known(fields.name);
  return typeof value === 'string' && value ? display(value, 240) : undefined;
};
function describe(fields: ConnectionEndpointFields): string {
  const helper = known(fields.helper), disposed = known(fields.disposed), connect = known(fields.connectToDispatcher);
  const origin = connect === undefined ? '' : fields.connectSource === 'agent' ? ' · explicit setting'
    : fields.connectSource === 'default' ? helper === true ? ' · helper policy' : ' · follows Orchestrate' : ' · origin unavailable';
  return [name(fields) ?? (fields.name.state === 'ok' && fields.name.value === '' ? 'Blank name' : fields.name.state === 'unavailable' && fields.name.reason === 'limit' ? 'Name exceeds this read’s limit' : 'Name unavailable'),
    helper === undefined ? 'helper role unavailable' : helper ? 'configured helper' : 'not marked as a helper',
    disposed === undefined ? 'disposal status unavailable' : disposed ? 'marked disposed' : 'not marked disposed',
    connect === undefined ? 'Connect to Dispatcher unavailable' : `Connect to Dispatcher ${connect ? 'On' : 'Off'}${origin}`].join(' · ');
}

/** Never consume retained fields after a failed association/admission/state. */
export function endpointCardFields(row: SavedDispatcherEndpointMetadataRow): EndpointCardFields {
  if (row.relationship !== 'recorded') return { saved: row.relationship === 'different-selected-project'
    ? 'Saved link project does not match this selected agent' : 'No matching saved link association' };
  const endpoint = row.endpoint;
  if (!endpoint) return { saved: 'Saved target details unavailable' };
  if (endpoint.state !== 'ok') return { saved: endpoint.reason === 'limit' ? 'Saved target details exceed this read’s limit' : 'Saved target details unavailable' };
  if (endpoint.value.record !== 'registered-primary') return { saved: endpoint.value.record === 'project-not-registered'
    ? 'Target project not found in saved project records' : 'No matching target in saved agent records' };
  const fields = endpoint.value.fields, savedName = name(fields), result: EndpointCardFields = { primaryAdmitted: true, savedName, displayName: savedName, nameOrigin: savedName ? 'saved' : undefined, saved: describe(fields) };
  const cache = row.hostCache;
  if (!cache) return result;
  if (cache.state !== 'ok') return { ...result, memory: 'Host memory fields unavailable' };
  if (cache.value.availability !== 'loaded' || cache.value.fields?.state !== 'ok') {
    const status = cache.value.availability;
    return { ...result, memory: status === 'not-loaded' ? 'Host memory not loaded'
      : status === 'not-in-loaded-index' ? 'Target not found in host memory'
        : status === 'namespace-unconfirmed' ? 'Host memory project association unconfirmed'
          : status === 'changed' ? 'Host memory changed during this read' : 'Host memory fields unavailable' };
  }
  const memoryFields = cache.value.fields.value, memoryName = name(memoryFields);
  return { ...result, ...(memoryName ? { displayName: memoryName, nameOrigin: 'host-memory' as const } : {}), memory: describe(memoryFields) };
}
