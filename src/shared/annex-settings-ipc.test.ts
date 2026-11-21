import { describe, expect, it, vi } from 'vitest';
import { LocalSettingsInputError, readLocalSettingsPatch } from './annex-settings-ipc';

const ID = '11111111-1111-4111-8111-111111111111';
const EPOCH = '22222222-2222-4222-a222-222222222222';
function patch(changes: Record<string, unknown> = { alias: 'Saved name' }, origin = 'identity', unset: unknown[] = []) {
  return {
    v: 1, requestId: ID, origin,
    base: { epoch: EPOCH, revision: 7, fields: Object.fromEntries([...Object.keys(changes), ...unset].map(k => [String(k), 3])) },
    changes, unset,
  };
}
function refused(raw: unknown, kind: 'invalid_envelope' | 'schema_invalid', id: string | null = null) {
  let caught: unknown;
  try { readLocalSettingsPatch(raw); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LocalSettingsInputError);
  expect(caught).toMatchObject({ kind, requestId: id, message: kind });
}

describe('local settings patch parser (not installed as an IPC handler)', () => {
  it('copies only explicit touched fields, preserving whitespace and empty text', () => {
    const raw = patch({ alias: '  custom name  ', color: '', icon: 'custom/icon' });
    const parsed = readLocalSettingsPatch(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed.base).not.toBe(raw.base);
    expect(parsed.base.fields).not.toBe(raw.base.fields);
    expect(parsed.changes).not.toBe(raw.changes);
    expect(parsed.unset).not.toBe(raw.unset);
    raw.changes.alias = 'later'; raw.base.fields.alias = 6;
    expect(parsed.changes.alias).toBe('  custom name  ');
    expect(parsed.base.fields.alias).toBe(3);
    expect(parsed.changes).not.toHaveProperty('enableServer');
  });

  it.each([
    ['enableServer', true], ['enableClient', false], ['loopbackOnly', true],
    ['deviceName', 'host'], ['autoReconnect', false], ['reachableAs', ''],
    ['networkEnabled', false], ['acceptHandoffs', true],
  ])('accepts explicit network field %s', (key, value) => {
    expect(readLocalSettingsPatch(patch({ [key]: value }, 'network-settings')).changes).toEqual({ [key]: value });
  });
  it.each(['enableServer', 'enableClient'])('accepts one palette switch %s', key => {
    expect(readLocalSettingsPatch(patch({ [key]: false }, 'command-palette')).changes).toEqual({ [key]: false });
  });
  it.each(['loopbackOnly', 'reachableAs', 'networkEnabled', 'acceptHandoffs'])('accepts explicit unset %s without inventing a default', key => {
    const parsed = readLocalSettingsPatch(patch({}, 'network-settings', [key]));
    expect(parsed.changes).toEqual({}); expect(parsed.unset).toEqual([key]);
  });
  it('accepts null-prototype data records without sharing them', () => {
    const raw = patch();
    Object.setPrototypeOf(raw, null); Object.setPrototypeOf(raw.base, null);
    Object.setPrototypeOf(raw.changes, null); Object.setPrototypeOf(raw.base.fields, null);
    expect(readLocalSettingsPatch(raw)).toEqual(patch());
  });
  it('does not compare a supplied epoch or versions to runtime authority', () => {
    const raw = patch(); raw.base.revision = Number.MAX_SAFE_INTEGER - 1; raw.base.fields.alias = 0;
    expect(readLocalSettingsPatch(raw).base).toEqual(raw.base);
  });

  it.each([null, undefined, true, 1, 'body', [], new Date(), Object.create({})])('refuses non-data envelope %#', raw => refused(raw, 'invalid_envelope'));
  it.each(['v', 'requestId', 'origin', 'base', 'changes', 'unset'])('refuses absent envelope key %s', key => {
    const raw: Record<string, unknown> = patch(); delete raw[key]; refused(raw, 'invalid_envelope');
  });
  it('refuses a legacy full body and unknown top-level keys', () => {
    refused({ enableServer: true, alias: 'old' }, 'invalid_envelope');
    refused({ ...patch(), enabled: true }, 'invalid_envelope');
  });
  it.each([0, 2, '1', null])('classifies unsupported v=%s as schema_invalid with safe request ID', v => refused({ ...patch(), v }, 'schema_invalid', ID));
  it.each(['', '11111111-1111-1111-8111-111111111111', '11111111-1111-4111-7111-111111111111', EPOCH.toUpperCase(), ID + '\n', 12])('refuses noncanonical request ID %#', requestId => refused({ ...patch(), requestId }, 'invalid_envelope'));
  it.each(['unknown', '', 'IDENTITY', null])('refuses unknown origin %#', origin => refused({ ...patch(), origin }, 'schema_invalid', ID));
  it.each(['epoch', 'revision', 'fields'])('refuses absent base key %s', key => {
    const raw = patch(); const base: Record<string, unknown> = raw.base; delete base[key]; refused(raw, 'invalid_envelope');
  });
  it('refuses an extra base key', () => refused({ ...patch(), base: { ...patch().base, extra: 1 } }, 'invalid_envelope'));
  it.each([null, [], new Date(), 1])('refuses invalid nested object %#', value => {
    refused({ ...patch(), changes: value }, 'invalid_envelope');
    refused({ ...patch(), base: value }, 'invalid_envelope');
    refused({ ...patch(), base: { ...patch().base, fields: value } }, 'invalid_envelope');
  });
  it('refuses a malformed epoch as schema invalid', () => {
    refused({ ...patch(), base: { ...patch().base, epoch: 'old-epoch' } }, 'schema_invalid', ID);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '3', null])('refuses invalid version %#', value => {
    refused({ ...patch(), base: { ...patch().base, revision: value } }, 'schema_invalid', ID);
    refused({ ...patch(), base: { ...patch().base, fields: { alias: value } } }, 'schema_invalid', ID);
  });
  it('refuses touched versions later than the supplied revision', () => {
    const raw = patch(); raw.base.fields.alias = 8; refused(raw, 'schema_invalid', ID);
  });
  it.each([{}, { alias: 3, color: 3 }, { color: 3 }])('requires fields to equal the touched set %#', fields => {
    refused({ ...patch(), base: { ...patch().base, fields } }, 'schema_invalid', ID);
  });
  it.each(['enabled', 'pin', '__proto__', 'constructor', 'unknown'])('refuses non-editable changed key %s', key => {
    const changes = Object.create(null); changes[key] = true;
    refused(patch(changes, 'network-settings'), 'schema_invalid', ID);
  });
  it.each([
    [{ alias: 'remote' }, 'network-settings'], [{ enableClient: true }, 'identity'],
    [{ color: 'custom' }, 'command-palette'], [{ enableClient: true, enableServer: false }, 'command-palette'],
  ] as const)('refuses origin/field mismatch %#', (changes, origin) => refused(patch(changes, origin), 'schema_invalid', ID));
  it('refuses empty, duplicate and set/unset overlap touched sets', () => {
    refused(patch({}), 'schema_invalid', ID);
    refused(patch({}, 'network-settings', ['loopbackOnly', 'loopbackOnly']), 'schema_invalid', ID);
    refused(patch({ loopbackOnly: true }, 'network-settings', ['loopbackOnly']), 'schema_invalid', ID);
    refused(patch({}, 'identity', ['alias']), 'schema_invalid', ID);
  });
  it.each([null, {}, 'reachableAs'])('refuses non-array unset %#', unset => refused({ ...patch(), unset }, 'invalid_envelope'));
  it.each(['alias', 'enableServer', 'unknown', undefined, null])('refuses non-optional unset %#', key => refused(patch({}, 'network-settings', [key]), 'schema_invalid', ID));
  it.each(['enableServer', 'enableClient', 'loopbackOnly', 'autoReconnect', 'networkEnabled', 'acceptHandoffs'])('requires boolean for %s', key => {
    for (const value of [0, 1, 'true', null, undefined]) refused(patch({ [key]: value }, 'network-settings'), 'schema_invalid', ID);
  });
  it.each([
    ['alias', 'identity', 200], ['deviceName', 'network-settings', 200],
    ['icon', 'identity', 128], ['color', 'identity', 128], ['reachableAs', 'network-settings', 1024],
  ] as const)('enforces exact UTF-16 length and well-formedness for %s', (key, origin, limit) => {
    for (const value of ['', 'a'.repeat(limit), '😀'.repeat(limit / 2)]) {
      expect(readLocalSettingsPatch(patch({ [key]: value }, origin)).changes).toEqual({ [key]: value });
    }
    for (const value of ['a'.repeat(limit + 1), '😀'.repeat(limit / 2) + 'a', '\ud800', '\udc00', 'ok\ud800bad', 1, undefined, null]) {
      refused(patch({ [key]: value }, origin), 'schema_invalid', ID);
    }
  });

  it.each(['top', 'base', 'fields', 'changes'])('refuses hidden/symbol/accessor/custom-prototype record keys at %s without invoking getter', location => {
    for (const flavor of ['hidden', 'symbol', 'accessor', 'prototype']) {
      const raw = patch(); const getter = vi.fn(() => 'hostile');
      const target = location === 'top' ? raw : location === 'base' ? raw.base : location === 'fields' ? raw.base.fields : raw.changes;
      if (flavor === 'hidden') Object.defineProperty(target, 'extra', { value: 1 });
      if (flavor === 'symbol') Object.defineProperty(target, Symbol('extra'), { value: 1, enumerable: true });
      if (flavor === 'accessor') Object.defineProperty(target, 'extra', { get: getter, enumerable: true });
      if (flavor === 'prototype') Object.setPrototypeOf(target, { inherited: 1 });
      refused(raw, 'invalid_envelope'); expect(getter).not.toHaveBeenCalled();
    }
  });
  it('refuses an accessor replacing a mandatory property without invoking it', () => {
    const raw = patch(); const getter = vi.fn(() => ID);
    Object.defineProperty(raw, 'requestId', { get: getter, enumerable: true });
    refused(raw, 'invalid_envelope'); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['hole', 'hidden-index', 'accessor', 'extra', 'hidden-extra', 'symbol', 'prototype', 'iterator'])('refuses non-dense/plain unset arrays: %s', flavor => {
    const unset = ['loopbackOnly']; const getter = vi.fn(() => 'loopbackOnly');
    if (flavor === 'hole') delete unset[0];
    if (flavor === 'hidden-index') Object.defineProperty(unset, '0', { value: 'loopbackOnly', enumerable: false });
    if (flavor === 'accessor') Object.defineProperty(unset, '0', { get: getter, enumerable: true });
    if (flavor === 'extra') Object.defineProperty(unset, 'extra', { value: 1, enumerable: true });
    if (flavor === 'hidden-extra') Object.defineProperty(unset, 'extra', { value: 1 });
    if (flavor === 'symbol') Object.defineProperty(unset, Symbol('extra'), { value: 1 });
    if (flavor === 'prototype') Object.setPrototypeOf(unset, null);
    if (flavor === 'iterator') Object.defineProperty(unset, Symbol.iterator, { get: getter });
    const raw = patch({}, 'network-settings'); raw.unset = unset; raw.base.fields = { loopbackOnly: 3 };
    refused(raw, 'invalid_envelope'); expect(getter).not.toHaveBeenCalled();
  });
  it('turns throwing reflection into a fixed envelope refusal without input text', () => {
    refused(new Proxy({}, { ownKeys() { throw new Error('secret input'); } }), 'invalid_envelope');
  });
});
