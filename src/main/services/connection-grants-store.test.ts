import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.base } }));
vi.mock('./clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [] } }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import {
  putConnectionDirection, fillConnectionTools, getConnectionDirection, linkCardDirections, linkConnectionDirections, removeCardDirection, onConnectionGrantsChanged,
  setConnectionTools, setConnectionLink, updateAgentNetworkLinks, _setConnectionGrantsVersionForTesting,
} from './connection-grants-store';
import { resetAllSettingsStoresForTests, setSettingsStoreAuditor } from './settings-store';
import { appLog } from './log-service';

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
  setSettingsStoreAuditor(null);
  fs.rmSync(state.base, { recursive: true, force: true });
});

describe('agent network source removal (#3659)', () => {
  const owner = { agentId: 'a', machineId: Array(16).fill('aa').join(':') };
  const remote = { agentId: 'remote', machineId: Array(16).fill('bb').join(':') };
  const pairs = [{ from: A, to: remote }];

  it('guards user-owned switches even when a remove supplies tool changes', async () => {
    await updateAgentNetworkLinks(pairs, owner, 'add', [['send_file']]);
    await setConnectionLink(A, remote, true);
    const saved = getConnectionDirection(A, remote)!;
    await expect(updateAgentNetworkLinks(pairs, owner, 'remove', [[]])).rejects.toThrow('owns these switches');
    expect(getConnectionDirection(A, remote)).toEqual(saved);
    await updateAgentNetworkLinks(pairs, owner, 'remove');
    const remaining = getConnectionDirection(A, remote)!;
    expect(remaining.link).toEqual(saved.link);
    expect(remaining.disabledTools).toEqual(saved.disabledTools);
    expect(remaining.disabledTools).toContain('send_file');
    expect(remaining.agentLinks?.[0].removedAt).toEqual(expect.any(String));
  });

  it('never changes saved switches on removal even if the caller owns them', async () => {
    await updateAgentNetworkLinks(pairs, owner, 'add', [['send_file']]);
    await updateAgentNetworkLinks(pairs, owner, 'remove', [[]]);
    expect(getConnectionDirection(A, remote)).toMatchObject({
      disabledTools: ['send_file'], agentLinks: [{ ...owner, removedAt: expect.any(String) }],
    });
  });

  it('keeps other agents sources and switches when removing only the caller source', async () => {
    const other = { agentId: 'other', machineId: owner.machineId };
    await updateAgentNetworkLinks(pairs, owner, 'add', [['send_file']]);
    await updateAgentNetworkLinks(pairs, other, 'add');
    await expect(updateAgentNetworkLinks(pairs, owner, 'remove', [[]])).rejects.toThrow('owns these switches');
    await updateAgentNetworkLinks(pairs, owner, 'remove');
    expect(getConnectionDirection(A, remote)).toMatchObject({
      disabledTools: ['send_file'], agentLinks: [{ ...owner, removedAt: expect.any(String) }, other],
    });
    expect(getConnectionDirection(A, remote)?.agentLinks?.[1].removedAt).toBeUndefined();
  });
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

  it('reports a failing listener without exposing its error or skipping the remaining listeners', async () => {
    const unsubscribeFailing = onConnectionGrantsChanged(() => { throw new Error('private listener details'); });
    const remaining = vi.fn();
    const unsubscribeRemaining = onConnectionGrantsChanged(remaining);
    try {
      await linkConnectionDirections([{ from: A, to: B }]);
      expect(getConnectionDirection(A, B)?.link).toBeDefined();
      expect(remaining).toHaveBeenCalledWith(A, B);
      expect(appLog).toHaveBeenCalledExactlyOnceWith('core:mcp', 'warn', 'Could not notify a connection-permissions listener after saving grants');
    } finally {
      unsubscribeFailing();
      unsubscribeRemaining();
    }
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


describe('Connections card sources', () => {
  it('writes both selected directions atomically and preserves them when switches change', async () => {
    await linkCardDirections([
      { from: A, to: B, disabledTools: ['clear_agent'], enabledTools: ['wake_agent'] },
      { from: B, to: A, disabledTools: ['compact_agent'], enabledTools: [] },
    ]);
    await setConnectionTools(A, B, ['send_file'], []);
    expect(getConnectionDirection(A, B)).toMatchObject({ cardLink: expect.anything(), disabledTools: ['send_file'] });
    expect(getConnectionDirection(B, A)).toMatchObject({ cardLink: expect.anything(), disabledTools: ['compact_agent'] });
    resetAllSettingsStoresForTests();
    expect(getConnectionDirection(A, B)?.cardLink).toBeDefined();
    await removeCardDirection(A, B);
    expect(getConnectionDirection(A, B)?.cardLink).toBeUndefined();
    expect(getConnectionDirection(B, A)?.cardLink).toBeDefined();
  });

  it('rejects both writes when a direction already has a user link', async () => {
    await linkConnectionDirections([{ from: B, to: A }]);
    await expect(linkCardDirections([
      { from: A, to: B, disabledTools: [], enabledTools: [] },
      { from: B, to: A, disabledTools: [], enabledTools: [] },
    ])).rejects.toThrow('already connected');
    expect(getConnectionDirection(A, B)).toBeUndefined();
    expect(getConnectionDirection(B, A)?.link).toBeDefined();
  });
});


describe('unchanged grant persistence', () => {
  const direction = {
    from: A, to: B, disabledTools: ['send_file'], updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('does not write, audit, notify or change bytes for repeated or older incoming directions', async () => {
    // Preserve even unknown raw metadata when the normalized direction is unchanged.
    const raw = JSON.stringify({ version: 1, directions: [{ ...direction, future: true }] });
    fs.writeFileSync(grantsPath(), raw);
    const open = vi.spyOn(fs.promises, 'open');
    const rename = vi.spyOn(fs.promises, 'rename');
    const audit = vi.fn();
    setSettingsStoreAuditor(audit);
    const changed = vi.fn();
    const unsubscribe = onConnectionGrantsChanged(changed);
    try {
      expect(await putConnectionDirection(direction)).toBe(false);
      expect(await putConnectionDirection({ ...direction, disabledTools: [], updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(fs.readFileSync(grantsPath(), 'utf-8')).toBe(raw);
      expect(fs.readdirSync(state.base)).toEqual(['connection-grants.json']);
    } finally {
      unsubscribe();
    }
  });

  it('persists a newer incoming direction and notifies only after it commits', async () => {
    await putConnectionDirection(direction);
    const rename = vi.spyOn(fs.promises, 'rename');
    const audit = vi.fn();
    setSettingsStoreAuditor(audit);
    const newer = { ...direction, disabledTools: [], updatedAt: '2026-01-03T00:00:00.000Z' };
    const changed = vi.fn(() => expect(readGrants().directions).toEqual([newer]));
    const unsubscribe = onConnectionGrantsChanged(changed);
    try {
      expect(await putConnectionDirection(newer)).toBe(true);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledExactlyOnceWith(A, B);
      resetAllSettingsStoresForTests();
      expect(getConnectionDirection(A, B)).toEqual(newer);
    } finally {
      unsubscribe();
    }
  });

  it('persists source and protection merges even when the incoming timestamp is older', async () => {
    await putConnectionDirection(direction);
    const rename = vi.spyOn(fs.promises, 'rename');
    const incoming = {
      ...direction, updatedAt: '2026-01-01T00:00:00.000Z', agentToolsProtected: true,
      agentLinks: [{ agentId: 'owner', machineId: 'remote', createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    expect(await putConnectionDirection(incoming)).toBe(true);
    expect(await putConnectionDirection(incoming)).toBe(false);
    expect(rename).toHaveBeenCalledTimes(1);
    resetAllSettingsStoresForTests();
    expect(getConnectionDirection(A, B)).toMatchObject({ ...incoming, updatedAt: direction.updatedAt });
  });

  it('rolls back failed real changes so a retry still persists', async () => {
    await putConnectionDirection(direction);
    const newer = { ...direction, disabledTools: [], updatedAt: '2026-01-03T00:00:00.000Z' };
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk failure'));
    const audit = vi.fn();
    setSettingsStoreAuditor(audit);
    const changed = vi.fn();
    const unsubscribe = onConnectionGrantsChanged(changed);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(putConnectionDirection(newer)).rejects.toThrow('disk failure');
      expect(getConnectionDirection(A, B)).toEqual(direction);
      expect(readGrants().directions).toEqual([direction]);
      expect(audit).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(await putConnectionDirection(newer)).toBe(true);
      expect(rename).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      resetAllSettingsStoresForTests();
      expect(getConnectionDirection(A, B)).toEqual(newer);
    } finally {
      unsubscribe();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('decides no-ops under the lock while preserving queued real changes', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');
    const newer = { ...direction, updatedAt: '2026-01-03T00:00:00.000Z', disabledTools: ['wake_agent'] };
    expect(await Promise.all([
      putConnectionDirection(newer),
      putConnectionDirection(direction),
      putConnectionDirection(newer),
      fillConnectionTools(A, B, []),
      setConnectionTools(Z, B, ['send_file']),
    ])).toEqual([true, false, false, false, expect.anything()]);
    expect(rename).toHaveBeenCalledTimes(2);
    resetAllSettingsStoresForTests();
    expect(getConnectionDirection(A, B)).toEqual(newer);
    expect(getConnectionDirection(Z, B)?.disabledTools).toEqual(['send_file']);
    expect(readGrants().directions).toHaveLength(2);
  });
});
