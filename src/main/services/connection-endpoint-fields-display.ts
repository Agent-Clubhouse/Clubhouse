/** Saved fields only. Registration/relationship admission and final witnesses belong to the reader. */
import { projectOrchestrationAgentFieldsForDisplay } from './orchestration-agent-fields';
import type { DisplayValue } from './display-settings';
import type { OrchestrationPolicySource } from '../../shared/orchestration-policy';
const ownDisplayValue = (raw: Record<string, unknown>, key: string): unknown => Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;

export interface ConnectionEndpointFields {
  id: string;
  name: DisplayValue<string>;
  helper: DisplayValue<boolean>;
  disposed: DisplayValue<boolean>;
  connectToDispatcher: DisplayValue<boolean>;
  connectSource?: OrchestrationPolicySource;
}
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const input = (field: string) => [{ field: `Related agent ${field}`, source: 'agent' as const, observedAt: Date.now() }];
const known = <T>(value: T, field: string): DisplayValue<T> => ({ state: 'ok', value, inputs: input(field) });
const unavailable = <T>(field: string, reason: 'invalid' | 'limit' = 'invalid'): DisplayValue<T> => ({ state: 'unavailable', reason, inputs: input(field) });

/** No unrelated row, raw config, provider, instructions, paths or global settings are returned. */
export function projectConnectionEndpointFieldsForDisplay(expectedId: string, raw: unknown): DisplayValue<ConnectionEndpointFields> {
  if (!identifier(expectedId) || !record(raw) || ownDisplayValue(raw, 'id') !== expectedId) return unavailable('identity');
  const name = ownDisplayValue(raw, 'name'), parent = ownDisplayValue(raw, 'parentAgentId'), disposedAt = ownDisplayValue(raw, 'disposedAt');
  const helper: DisplayValue<boolean> = parent === undefined || parent === '' ? known(false, 'helper role')
    : identifier(parent) ? known(true, 'helper role') : unavailable('helper role');
  // Match the local disposed flag. A malformed date is not used as a timestamp.
  const disposed: DisplayValue<boolean> = disposedAt === undefined ? known(false, 'disposed flag')
    : typeof disposedAt === 'string' ? known(!!disposedAt, 'disposed flag') : unavailable('disposed flag');
  const policy = projectOrchestrationAgentFieldsForDisplay({ parentAgentId: parent, orchestration: ownDisplayValue(raw, 'orchestration') });
  const connectToDispatcher = helper.state === 'ok' ? policy.fields.connectToDispatcher : unavailable<boolean>('Dispatcher connection');
  return known({ id: expectedId, name: typeof name !== 'string' ? unavailable<string>('name') : name.length > 1024 ? unavailable<string>('name', 'limit') : known(name, 'name'),
    helper, disposed, connectToDispatcher,
    ...(connectToDispatcher.state === 'ok' ? { connectSource: policy.sources.connectToDispatcher } : {}) }, 'saved fields');
}

/** Configured eligibility only: never a runtime, MCP connection, grant or effective permission. */
export function configuredConnectionEndpointEligibility(fields: ConnectionEndpointFields): DisplayValue<'eligible' | 'gone' | 'connect-off'> {
  if (fields.disposed.state === 'ok' && fields.disposed.value || fields.helper.state === 'ok' && fields.helper.value) return known('gone', 'configured eligibility');
  if (fields.disposed.state !== 'ok' || fields.helper.state !== 'ok' || fields.connectToDispatcher.state !== 'ok') return unavailable('configured eligibility');
  return known(fields.connectToDispatcher.value ? 'eligible' : 'connect-off', 'configured eligibility');
}

/** Same bounded fields, observed in host-session cache; not actual runtime or disk freshness. */
export function projectLoadedConnectionEndpointFieldsForDisplay(expectedId: string, raw: unknown): DisplayValue<ConnectionEndpointFields> {
  const projected = projectConnectionEndpointFieldsForDisplay(expectedId, raw), observedAt = Date.now();
  const evidence = <T>(value: DisplayValue<T>): DisplayValue<T> => ({ ...value, inputs: value.inputs.map((input) => ({ ...input, source: 'host-cache', observedAt })) });
  if (projected.state !== 'ok') return evidence(projected);
  const fields = projected.value;
  return { ...evidence(projected), state: 'ok', value: { ...fields, name: evidence(fields.name), helper: evidence(fields.helper), disposed: evidence(fields.disposed), connectToDispatcher: evidence(fields.connectToDispatcher) } };
}
