import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandRegistry, commandRegistry } from './command-registry';
import type { CommandDefinition, ExecutionContext } from './command-registry';

function makeDef(overrides: Partial<CommandDefinition> & { id: string }): CommandDefinition {
  return {
    category: 'test',
    label: overrides.id,
    description: `Test command ${overrides.id}`,
    process: 'main',
    handler: () => ({ success: true }),
    ...overrides,
  };
}

const CTX: ExecutionContext = { source: 'mcp' };

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  /* ---- register / get / size ---- */

  it('registers and retrieves a command', () => {
    const def = makeDef({ id: 'test.one' });
    registry.register(def);
    expect(registry.get('test.one')).toBe(def);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    registry.register(makeDef({ id: 'dup.cmd' }));
    expect(() => registry.register(makeDef({ id: 'dup.cmd' }))).toThrow(
      'Command already registered: dup.cmd',
    );
  });

  it('returns undefined for unknown commands', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  /* ---- dispose / unregister ---- */

  it('dispose removes the command', () => {
    const disposable = registry.register(makeDef({ id: 'to.remove' }));
    expect(registry.size).toBe(1);
    disposable.dispose();
    expect(registry.get('to.remove')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('dispose is idempotent', () => {
    const disposable = registry.register(makeDef({ id: 'idem' }));
    disposable.dispose();
    disposable.dispose(); // should not throw
    expect(registry.size).toBe(0);
  });

  /* ---- list ---- */

  it('lists all commands', () => {
    registry.register(makeDef({ id: 'a.one', category: 'alpha' }));
    registry.register(makeDef({ id: 'b.two', category: 'beta' }));
    expect(registry.list()).toHaveLength(2);
  });

  it('filters by category (case-insensitive)', () => {
    registry.register(makeDef({ id: 'a.one', category: 'Canvas' }));
    registry.register(makeDef({ id: 'b.two', category: 'agent' }));
    const canvas = registry.list({ category: 'canvas' });
    expect(canvas).toHaveLength(1);
    expect(canvas[0].id).toBe('a.one');
  });

  it('filters by process', () => {
    registry.register(makeDef({ id: 'main.cmd', process: 'main' }));
    registry.register(makeDef({ id: 'rend.cmd', process: 'renderer' }));
    expect(registry.list({ process: 'renderer' })).toHaveLength(1);
  });

  it('filters by both category and process', () => {
    registry.register(makeDef({ id: 'a', category: 'canvas', process: 'renderer' }));
    registry.register(makeDef({ id: 'b', category: 'canvas', process: 'main' }));
    registry.register(makeDef({ id: 'c', category: 'agent', process: 'renderer' }));
    const result = registry.list({ category: 'canvas', process: 'renderer' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  /* ---- execute ---- */

  it('executes a command handler', async () => {
    const handler = vi.fn().mockReturnValue({ success: true, data: { id: '42' } });
    registry.register(makeDef({ id: 'run.me', handler }));
    const result = await registry.execute('run.me', CTX, { foo: 'bar' });
    expect(result).toEqual({ success: true, data: { id: '42' } });
    expect(handler).toHaveBeenCalledWith(CTX, { foo: 'bar' });
  });

  it('executes async handlers', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: 'async-ok' });
    registry.register(makeDef({ id: 'async.cmd', handler }));
    const result = await registry.execute('async.cmd', CTX);
    expect(result).toEqual({ success: true, data: 'async-ok' });
  });

  it('returns error for unknown command', async () => {
    const result = await registry.execute('ghost', CTX);
    expect(result).toEqual({ success: false, error: 'Unknown command: ghost' });
  });

  it('catches handler errors and returns error result', async () => {
    const handler = () => { throw new Error('boom'); };
    registry.register(makeDef({ id: 'err.cmd', handler }));
    const result = await registry.execute('err.cmd', CTX);
    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('catches non-Error throws', async () => {
    const handler = () => { throw 'string-error'; };
    registry.register(makeDef({ id: 'str.err', handler }));
    const result = await registry.execute('str.err', CTX);
    expect(result).toEqual({ success: false, error: 'string-error' });
  });

  it('uses empty args when none provided', async () => {
    const handler = vi.fn().mockReturnValue({ success: true });
    registry.register(makeDef({ id: 'no.args', handler }));
    await registry.execute('no.args', CTX);
    expect(handler).toHaveBeenCalledWith(CTX, {});
  });

  /* ---- events ---- */

  it('fires onDidRegister when a command is registered', () => {
    const listener = vi.fn();
    registry.onDidRegister(listener);
    const def = makeDef({ id: 'event.test' });
    registry.register(def);
    expect(listener).toHaveBeenCalledWith(def);
  });

  it('fires onDidUnregister when a command is disposed', () => {
    const listener = vi.fn();
    registry.onDidUnregister(listener);
    const disposable = registry.register(makeDef({ id: 'event.unreg' }));
    disposable.dispose();
    expect(listener).toHaveBeenCalledWith('event.unreg');
  });

  it('event listener can be disposed', () => {
    const listener = vi.fn();
    const sub = registry.onDidRegister(listener);
    registry.register(makeDef({ id: 'first' }));
    expect(listener).toHaveBeenCalledTimes(1);
    sub.dispose();
    registry.register(makeDef({ id: 'second' }));
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  /* ---- clear ---- */

  it('clear removes all commands and fires unregister events', () => {
    const listener = vi.fn();
    registry.onDidUnregister(listener);
    registry.register(makeDef({ id: 'a' }));
    registry.register(makeDef({ id: 'b' }));
    registry.clear();
    expect(registry.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  /* ---- singleton ---- */

  it('exports a singleton commandRegistry instance', () => {
    expect(commandRegistry).toBeInstanceOf(CommandRegistry);
  });

  /* ---- CQ-15: event listener exception isolation ---- */

  it('continues firing subsequent listeners when one throws (CQ-15)', () => {
    const second = vi.fn();
    registry.onDidRegister(() => { throw new Error('listener boom'); });
    registry.onDidRegister(second);

    // Should not throw, and second listener should still be called
    expect(() => registry.register(makeDef({ id: 'isolated' }))).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs but does not propagate listener errors (CQ-15)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.onDidRegister(() => { throw new Error('event-error'); });

    registry.register(makeDef({ id: 'log-test' }));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CommandRegistry]'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('unregister events continue despite throwing listeners (CQ-15)', () => {
    const second = vi.fn();
    registry.onDidUnregister(() => { throw new Error('unreg boom'); });
    registry.onDidUnregister(second);

    const d = registry.register(makeDef({ id: 'unreg-isolated' }));
    expect(() => d.dispose()).not.toThrow();
    expect(second).toHaveBeenCalledWith('unreg-isolated');
  });
});
