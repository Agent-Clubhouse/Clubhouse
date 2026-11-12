import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  annexProtocolVersions, registerAnnexDeliveryProtocol, snapshotAnnexProtocolContext, snapshotAnnexProtocolJson,
  type AnnexDeliveryProtocol,
} from './annex-delivery-protocols';

const protocol = (): AnnexDeliveryProtocol => ({
  name: 'handoff',
  tools: { offer: 'durable', snapshot: 'durable', cancel: 'durable', get: 'read', capacity: 'read' },
  authorizeOutgoing: async () => ({ allowed: true }),
  checkOutgoing: () => ({ allowed: true }),
  authorizeIncoming: () => ({ allowed: true }),
  receive: async () => ({ content: [] }),
});
let unregister: (() => void) | undefined;
afterEach(() => { unregister?.(); unregister = undefined; });

describe('disabled protocol registry', () => {
  it('advertises only a complete fixed registration and never partial or expanded tools', () => {
    expect(annexProtocolVersions()).toEqual({});
    expect(() => registerAnnexDeliveryProtocol({ ...protocol(), tools: { offer: 'durable' } })).toThrow();
    expect(() => registerAnnexDeliveryProtocol({ ...protocol(), tools: { ...protocol().tools, wake_agent: 'durable' } })).toThrow();
    const invalid = protocol();
    Reflect.set(invalid, 'checkOutgoing', undefined);
    expect(() => registerAnnexDeliveryProtocol(invalid)).toThrow();
    unregister = registerAnnexDeliveryProtocol(protocol());
    expect(annexProtocolVersions()).toEqual({ handoff: 1 });
    expect(() => registerAnnexDeliveryProtocol(protocol())).toThrow();
    unregister();
    expect(annexProtocolVersions()).toEqual({});
  });
});

describe('lossless protocol JSON', () => {
  it.each([
    ['undefined', { a: undefined }], ['function', { a: () => 1 }], ['symbol', { a: Symbol('x') }],
    ['bigint', { a: 1n }], ['NaN', { a: NaN }], ['infinity', { a: Infinity }], ['negative zero', { a: -0 }],
    ['Date', { a: new Date() }], ['sparse array', { a: Array(1) }],
    ['extra array property', { a: Object.assign([1], { extra: 2 }) }],
  ])('refuses %s instead of changing the approved content', (_name, value) => {
    expect(() => snapshotAnnexProtocolJson(value)).toThrow();
  });

  it('rejects cycles, symbols, hidden fields and accessors without invoking user code', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotAnnexProtocolJson(cycle)).toThrow('cycles');
    expect(() => snapshotAnnexProtocolJson({ [Symbol('hidden')]: 1 })).toThrow();
    expect(() => snapshotAnnexProtocolJson(Object.defineProperty({}, 'hidden', { value: 1 }))).toThrow();
    const get = vi.fn(() => 'coerced');
    expect(() => snapshotAnnexProtocolJson(Object.defineProperty({}, 'a', { enumerable: true, get }))).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(() => snapshotAnnexProtocolJson({ toJSON: get })).toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('uses actual JSON integer-key ordering, preserves special keys and freezes every shared payload node', () => {
    const value = snapshotAnnexProtocolJson(JSON.parse('{"z":"\u00e9","10":10,"2":2,"__proto__":{"bad":true},"a":[1,true,null]}'));
    expect(JSON.stringify(value)).toBe('{"2":2,"10":10,"__proto__":{"bad":true},"a":[1,true,null],"z":"\u00e9"}');
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'bad')).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(Reflect.get(value as object, 'a'))).toBe(true);
  });

  it('bounds local context, permits only a receipt reference and retains the original full source call identity', () => {
    const context = {
      senderMachine: 'sender',
      sourceCall: { toolName: 'agent__target__offer', callKey: 'call\0caller\0agent__target__offer\0original-args-hash' },
      localAuthorization: { requestId: 'original-human-request' },
    };
    expect(snapshotAnnexProtocolContext(context)).toEqual(context);
    expect(() => snapshotAnnexProtocolContext({ ...context, localAuthorization: { ...context.localAuthorization, approved: true } })).toThrow();
    expect(() => snapshotAnnexProtocolContext({ ...context, sourceCall: { ...context.sourceCall, callKey: '\0'.repeat(3990) } })).toThrow();
  });
});
