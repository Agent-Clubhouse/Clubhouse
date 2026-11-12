import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-delivery-store-'));

import {
  createAnnexDeliveryStore, deliveryHash, DELIVERY_MAX_RECORDS, DELIVERY_RETENTION_MS, type ReceiverDelivery,
} from './annex-delivery-store';

afterEach(() => vi.restoreAllMocks());
const receipt = (id: number, at: number): ReceiverDelivery => ({
  key: `peer/${id}`, payloadHash: deliveryHash(id), state: 'delivered',
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
  result: { content: [{ type: 'text', text: 'runtime accepted' }] },
});

describe('durable Annex delivery store', () => {
  it('retains all 10k unexpired dedupe receipts and refuses admission rather than evicting one', async () => {
    const now = Date.now();
    const store = createAnnexDeliveryStore('bounded.json');
    await store.update((file) => { file.inbox = Array.from({ length: DELIVERY_MAX_RECORDS }, (_, i) => receipt(i, now)); }, now);
    await expect(store.update((file) => { file.inbox.push(receipt(DELIVERY_MAX_RECORDS, now)); }, now)).rejects.toMatchObject({ code: 'delivery_store_full' });
    const restarted = createAnnexDeliveryStore('bounded.json');
    expect(restarted.get().inbox).toHaveLength(DELIVERY_MAX_RECORDS);
    expect(restarted.get().inbox[0].key).toBe('peer/0');
    await restarted.update((file) => { file.inbox.push(receipt(DELIVERY_MAX_RECORDS, now + DELIVERY_RETENTION_MS)); }, now + DELIVERY_RETENTION_MS);
    expect(restarted.get().inbox.map((r) => r.key)).toEqual([`peer/${DELIVERY_MAX_RECORDS}`]);
  });

  it('fails closed on unreadable or incomplete state instead of losing receiver dedupe', async () => {
    for (const [filename, body] of [['torn.json', '{'], ['incomplete.json', '{}'], ['invalid.json', '{"version":1,"inbox":[{}],"outbox":[],"deliveries":[]}']]) {
      fs.writeFileSync(path.join(state.base, filename), body);
      const store = createAnnexDeliveryStore(filename);
      expect(() => store.get()).toThrow('durable delivery store is unreadable');
      await expect(store.update(() => {})).rejects.toMatchObject({ code: 'delivery_store_unreadable' });
      expect(fs.readFileSync(path.join(state.base, filename), 'utf8')).toBe(body);
    }
  });

  it('publishes neither a claim nor terminal receipt until the atomic write commits', async () => {
    const store = createAnnexDeliveryStore('commit.json');
    await store.update(() => {});
    const original = fs.promises.rename;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => { await gate; return original(from, to); });
    const saving = store.update((file) => { file.inbox.push(receipt(1, Date.now())); });
    await vi.waitFor(() => expect(fs.promises.rename).toHaveBeenCalled());
    expect(store.get().inbox).toHaveLength(0);
    expect(createAnnexDeliveryStore('commit.json').get().inbox).toHaveLength(0);
    release();
    await saving;
    expect(createAnnexDeliveryStore('commit.json').get().inbox).toHaveLength(1);
  });

  it('migrates the old persisted outbox in place without changing its call id or order', async () => {
    const queuedAt = new Date().toISOString();
    fs.writeFileSync(path.join(state.base, 'legacy.json'), JSON.stringify({ version: 1, items: ['first', 'second'].map((id) => ({
      id, machine: 'peer', queuedAt, body: { v: 1, callId: id, from: { agentId: 'sender', name: 'Sender' }, to: 'receiver', tool: 'send_message', args: { message: id } },
    })) }));
    const store = createAnnexDeliveryStore('legacy.json');
    expect(store.get().outbox.map((r) => r.id)).toEqual(['first', 'second']);
    await store.update(() => {});
    expect(createAnnexDeliveryStore('legacy.json').get().deliveries.map((r) => r.callId)).toEqual(['first', 'second']);
  });
});
