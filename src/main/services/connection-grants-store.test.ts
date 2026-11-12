import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.base } }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [] } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import {
  getConnectionDirection, linkConnectionDirections, onConnectionGrantsChanged,
  setConnectionTools, _setConnectionGrantsVersionForTesting,
} from './connection-grants-store';
import { resetAllSettingsStoresForTests } from './settings-store';

const A = { agentId: 'a' };
const B = { agentId: 'b' };
const Z = { agentId: 'z' };
const grantsPath = () => path.join(state.base, 'connection-grants.json');
const readGrants = () => JSON.parse(fs.readFileSync(grantsPath(), 'utf-8')) as { directions: unknown[] };

beforeEach(() => {
  state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-grants-store-'));
  resetAllSettingsStoresForTests();
});

afterEach(() => {
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('atomic explicit user links', () => {
  it('deduplicates directions, including accepted self-directions, in one durable mutation', async () => {
    const changed = vi.fn();
    const unsubscribe = onConnectionGrantsChanged(changed);
    const rename = vi.spyOn(fs.promises, 'rename');
    try {
      const written = await linkConnectionDirections([
        { from: A, to: B }, { from: B, to: A }, { from: A, to: B }, { from: A, to: A }, { from: A, to: A },
      ]);
      expect(written).toHaveLength(3);
      expect(readGrants().directions).toHaveLength(3);
      expect(rename.mock.calls.filter(([, to]) => String(to) === grantsPath())).toHaveLength(1);
      expect(changed.mock.calls).toEqual([[A, B], [B, A], [A, A]]);
    } finally {
      unsubscribe();
    }
  });

  it('rejects an invalid address before writing any valid direction from the same request', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');
    await expect(linkConnectionDirections([{ from: A, to: B }, { from: { agentId: '' }, to: A }])).rejects.toThrow('address');
    expect(getConnectionDirection(A, B)).toBeUndefined();
    expect(rename).not.toHaveBeenCalled();
  });

  it('preserves linked and unrelated raw records instead of normalizing or repairing the store', async () => {
    const linked = {
      from: A, to: B, disabledTools: ['send_file'], enabledTools: ['future_enabled'],
      link: { createdAt: '2025-01-01T00:00:00.000Z' }, updatedAt: '2025-02-01T00:00:00.000Z', futureField: 'retained',
    };
    const unrelated = { from: Z, to: A, disabledTools: ['future_denied', 'future_denied', 1], futureField: true };
    const malformed = { from: { agentId: '' }, to: B, unknown: 'retain' };
    fs.writeFileSync(grantsPath(), JSON.stringify({ version: 1, directions: [linked, unrelated, malformed], migrations: ['saved'] }));
    await linkConnectionDirections([{ from: A, to: B }, { from: B, to: A }]);
    expect(readGrants()).toEqual({
      version: 1, directions: [linked, unrelated, malformed, expect.objectContaining({
        from: B, to: A, disabledTools: ['clear_agent', 'compact_agent'], enabledTools: ['wake_agent'], link: expect.anything(),
      })], migrations: ['saved'],
    });
  });

  it('reads saved switches and concurrent edits under the standard update lock', async () => {
    await Promise.all([
      setConnectionTools(A, B, ['send_file', 'future_denied'], ['future_enabled']),
      linkConnectionDirections([{ from: A, to: B }, { from: B, to: A }]),
      setConnectionTools(Z, B, ['wake_agent'], []),
    ]);
    expect(getConnectionDirection(A, B)).toMatchObject({
      disabledTools: ['send_file', 'future_denied'], enabledTools: ['future_enabled'], link: expect.anything(),
    });
    expect(getConnectionDirection(B, A)?.link).toBeDefined();
    expect(getConnectionDirection(Z, B)).toMatchObject({ disabledTools: ['wake_agent'] });
    expect(readGrants().directions).toHaveLength(3);
  });

  it('checks a newer store version under the lock without replacing it', async () => {
    const versionChange = _setConnectionGrantsVersionForTesting(2);
    const link = linkConnectionDirections([{ from: A, to: B }, { from: B, to: A }]);
    await versionChange;
    await expect(link).rejects.toThrow('newer Clubhouse');
    expect(readGrants()).toEqual({ version: 2, directions: [] });
  });

  it('refuses a malformed directions container without overwriting its bytes', async () => {
    const raw = JSON.stringify({ version: 1, directions: { unknown: 'retain' } });
    fs.writeFileSync(grantsPath(), raw);
    await expect(linkConnectionDirections([{ from: A, to: B }])).rejects.toThrow('directions');
    expect(fs.readFileSync(grantsPath(), 'utf-8')).toBe(raw);
  });
});
