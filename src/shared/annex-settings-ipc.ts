/** Local settings DTOs only. Origins, IDs and versions confer no authority. */
import type { AnnexSettings } from './types';

export const EDITABLE_KEYS = Object.freeze([
  'enableServer', 'enableClient', 'loopbackOnly', 'deviceName', 'alias', 'icon',
  'color', 'autoReconnect', 'reachableAs', 'networkEnabled', 'acceptHandoffs',
] as const);
export type EditableKey = typeof EDITABLE_KEYS[number];
export type OptionalEditableKey = 'loopbackOnly' | 'reachableAs' | 'networkEnabled' | 'acceptHandoffs';
export type LocalOrigin = 'identity' | 'network-settings' | 'command-palette';
export interface LocalSettingsEdit {
  origin: LocalOrigin;
  changes: Partial<Pick<AnnexSettings, EditableKey>>;
  unset: OptionalEditableKey[];
}
export interface LocalSettingsPatch extends LocalSettingsEdit {
  v: 1;
  requestId: string;
  base: { epoch: string; revision: number; fields: Partial<Record<EditableKey, number>> };
}

const limits = { deviceName: 200, alias: 200, icon: 128, color: 128, reachableAs: 1024 };
const origins: Record<LocalOrigin, readonly EditableKey[]> = {
  identity: ['alias', 'color', 'icon'],
  'network-settings': ['enableServer', 'enableClient', 'loopbackOnly', 'deviceName',
    'autoReconnect', 'reachableAs', 'networkEnabled', 'acceptHandoffs'],
  'command-palette': ['enableServer', 'enableClient'],
};
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const version = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;

export class LocalSettingsInputError extends Error {
  constructor(readonly kind: 'invalid_envelope' | 'schema_invalid', readonly requestId: string | null = null) {
    super(kind); // Never include hostile input in the error text.
  }
}
const envelope = (): never => { throw new LocalSettingsInputError('invalid_envelope'); };
const schema = (id: string): never => { throw new LocalSettingsInputError('schema_invalid', id); };
type DataRecord = Record<string, { value: unknown }>;
const owns = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function dataRecord(value: unknown): DataRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return envelope();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return envelope();
  const result: DataRecord = Object.create(null);
  const keys = Reflect.ownKeys(value);
  // No object in this DTO can have more than the editable field count.
  if (keys.length > EDITABLE_KEYS.length) return envelope();
  for (const key of keys) {
    if (typeof key !== 'string') return envelope();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !owns(descriptor, 'value') || descriptor.enumerable !== true) return envelope();
    result[key] = { value: descriptor.value };
  }
  return result;
}
function exactKeys(record: DataRecord, keys: readonly string[]): void {
  if (Reflect.ownKeys(record).length !== keys.length || !keys.every(key => owns(record, key))) envelope();
}
function denseUnset(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return envelope();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !owns(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > EDITABLE_KEYS.length || length.enumerable !== false) return envelope();
  if (Reflect.ownKeys(value).length !== length.value + 1) return envelope();
  const result: unknown[] = [];
  for (let i = 0; i < length.value; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !owns(descriptor, 'value') || descriptor.enumerable !== true) return envelope();
    result.push(descriptor.value);
  }
  // Every canonical index plus length accounts for all own keys. No raw iterator/getter is used.
  return result;
}
function isEditable(value: unknown): value is EditableKey {
  return typeof value === 'string' && EDITABLE_KEYS.some(key => key === value);
}
function isOptionalKey(value: unknown): value is OptionalEditableKey {
  return value === 'loopbackOnly' || value === 'reachableAs' || value === 'networkEnabled' || value === 'acceptHandoffs';
}
function isBooleanKey(key: EditableKey): key is 'enableServer' | 'enableClient' | 'loopbackOnly' | 'autoReconnect' | 'networkEnabled' | 'acceptHandoffs' {
  return key === 'enableServer' || key === 'enableClient' || key === 'loopbackOnly'
    || key === 'autoReconnect' || key === 'networkEnabled' || key === 'acceptHandoffs';
}
function isOrigin(value: unknown): value is LocalOrigin {
  return value === 'identity' || value === 'network-settings' || value === 'command-palette';
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Validate and detach a local patch; current epoch/version/real caller checks belong to admission. */
export function readLocalSettingsPatch(raw: unknown): LocalSettingsPatch {
  try {
    const top = dataRecord(raw);
    exactKeys(top, ['v', 'requestId', 'origin', 'base', 'changes', 'unset']);
    if (!uuid(top.requestId.value)) return envelope();
    const id = top.requestId.value;
    if (top.v.value !== 1 || !isOrigin(top.origin.value)) return schema(id);
    const origin = top.origin.value;
    const base = dataRecord(top.base.value);
    exactKeys(base, ['epoch', 'revision', 'fields']);
    if (!uuid(base.epoch.value) || !version(base.revision.value)) return schema(id);
    const epoch = base.epoch.value, revision = base.revision.value;
    const suppliedFields = dataRecord(base.fields.value);
    const suppliedChanges = dataRecord(top.changes.value);
    const unset: OptionalEditableKey[] = [];
    for (const key of denseUnset(top.unset.value)) {
      if (!isOptionalKey(key)) return schema(id);
      unset.push(key);
    }
    const changes: LocalSettingsEdit['changes'] = {};
    const touched: EditableKey[] = [];
    for (const key of Reflect.ownKeys(suppliedChanges)) {
      if (!isEditable(key)) return schema(id);
      const value = suppliedChanges[key].value;
      if (isBooleanKey(key)) {
        if (typeof value !== 'boolean') return schema(id);
        changes[key] = value;
      } else {
        if (typeof value !== 'string' || value.length > limits[key] || !wellFormed(value)) return schema(id);
        changes[key] = value;
      }
      touched.push(key);
    }
    touched.push(...unset);
    if (!touched.length || touched.length > EDITABLE_KEYS.length || new Set(touched).size !== touched.length) return schema(id);
    if (touched.some(key => !origins[origin].includes(key)) || origin === 'command-palette' && touched.length !== 1) return schema(id);
    const suppliedKeys = Reflect.ownKeys(suppliedFields);
    if (suppliedKeys.length !== touched.length || suppliedKeys.some(key => !isEditable(key) || !touched.includes(key))) return schema(id);
    const fields: Partial<Record<EditableKey, number>> = {};
    for (const key of touched) {
      const value = suppliedFields[key]?.value;
      if (!version(value) || value > revision) return schema(id);
      fields[key] = value;
    }
    const request: LocalSettingsPatch = { v: 1, requestId: id, origin, base: { epoch, revision, fields }, changes, unset };
    if (new TextEncoder().encode(JSON.stringify(request)).length > 8192) return schema(id);
    return structuredClone(request);
  } catch (error) {
    if (error instanceof LocalSettingsInputError) throw error;
    // Reflection/clone failures receive a fixed refusal, without quoting caller data.
    return envelope();
  }
}
