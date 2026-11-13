import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../telemetry/persist', () => ({ persist: { recovery: vi.fn(), timed: (_area: string, work: () => Promise<void>) => work() } }));
import { HandoffCommandStore } from './handoff-command-store';
const command = () => ({ id: randomUUID(), operationId: randomUUID(), from: { agentId: 'sender', machine: Array(16).fill('ab').join(':') }, reason: 'Reassigned' });
beforeEach(() => { state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-commands-')); });
afterEach(() => { fs.rmSync(state.dir, { recursive: true, force: true }); });

describe('durable handoff cancellation and notification claims', () => {
  it('keeps one pending cancellation across restart and removes only the acknowledged operation', async () => {
    const pending = command();
    const first = new HandoffCommandStore();
    await first.put(pending);
    await first.put(pending);
    const restarted = new HandoffCommandStore();
    expect(restarted.list()).toEqual([pending]);
    await expect(restarted.put({ ...pending, operationId: randomUUID() })).rejects.toThrow('Conflicting');
    await restarted.remove(randomUUID());
    expect(new HandoffCommandStore().list()).toEqual([pending]);
    await restarted.remove(pending.operationId);
    expect(new HandoffCommandStore().list()).toEqual([]);
  });

  it('serializes competing notice claims and retains a claim across restart and uncertain delivery', async () => {
    const store = new HandoffCommandStore();
    expect(await Promise.all([store.claimNotice('id:receiver', 1), store.claimNotice('id:receiver', 1)])).toEqual([true, false]);
    const restarted = new HandoffCommandStore();
    expect(restarted.hasNotice('id:receiver', 1)).toBe(true);
    expect(await restarted.claimNotice('id:receiver', 1)).toBe(false);
    expect(await restarted.claimNotice('id:receiver', 2)).toBe(true);
    await restarted.deliveredNotice('id:receiver', 2);
    expect(await new HandoffCommandStore().claimNotice('id:receiver', 2)).toBe(false);
    expect(await new HandoffCommandStore().claimNotice('id:other', 2)).toBe(true);
  });

  it('fails closed on malformed storage without overwriting evidence, and never stores secret reasons', async () => {
    const store = new HandoffCommandStore();
    expect(() => store.put({ ...command(), reason: `ghp_${'a'.repeat(36)}` })).toThrow('Invalid');
    expect(fs.readdirSync(state.dir)).toEqual([]);
    const file = path.join(state.dir, 'handoff-commands.json');
    fs.writeFileSync(file, '{broken');
    const broken = new HandoffCommandStore();
    expect(() => broken.list()).toThrow('unreadable');
    await expect(broken.put(command())).rejects.toThrow('unreadable');
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
});

it('persists attempts and acknowledgements and prunes retired notice metadata across restart', async () => {
  const first = randomUUID(); const second = randomUUID(); const store = new HandoffCommandStore();
  await store.markUndelivered(first); expect(new HandoffCommandStore().isUndelivered(first)).toBe(true);
  await store.markAttempted(first); expect(new HandoffCommandStore().isUndelivered(first)).toBe(false);
  await store.acknowledge(first, 2); await store.claimNotice(`${first}:receiver`, 2); await store.claimNotice(`${second}:receiver`, 1);
  expect(new HandoffCommandStore().acknowledged(first)).toBe(2);
  await store.prune(new Set([second]));
  const restarted = new HandoffCommandStore();
  expect(restarted.acknowledged(first)).toBeUndefined(); expect(restarted.hasNotice(`${first}:receiver`, 2)).toBe(false); expect(restarted.hasNotice(`${second}:receiver`, 1)).toBe(true);
});
