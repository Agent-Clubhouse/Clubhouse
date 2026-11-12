import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ base: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => state.base } }));
state.base = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-delivery-store-'));

import {
  createAnnexDeliveryStore, deliveryHash, DELIVERY_MAX_BYTES, DELIVERY_MAX_RECORDS, DELIVERY_MAX_RESULT_BYTES, DELIVERY_RETENTION_MS, type DeliveryFile, type ReceiverDelivery,
} from './annex-delivery-store';

afterEach(() => vi.restoreAllMocks());
const receipt = (id: number, at: number): ReceiverDelivery => ({
  key: `peer/${id}`, payloadHash: deliveryHash(id), state: 'delivered',
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
  result: { content: [{ type: 'text', text: 'runtime accepted' }] },
});

describe('durable Annex delivery store', () => {
  it.each([null, false, 7, 'not a store', [], { version: 1, outbox: [], inbox: null, deliveries: [] }])('refuses raw non-store JSON %j without overwriting it', async (raw) => {
    const filename = 'raw-non-store.json';
    const filePath = path.join(state.base, filename);
    const original = JSON.stringify(raw);
    fs.writeFileSync(filePath, original);
    const store = createAnnexDeliveryStore(filename);
    expect(() => store.get()).toThrow('durable delivery store is unreadable');
    await expect(store.update(() => {})).rejects.toMatchObject({ code: 'delivery_store_unreadable' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, outbox: [], inbox: [], deliveries: [] }));
    expect(() => store.get()).toThrow('durable delivery store is unreadable');
    expect(createAnnexDeliveryStore(filename).get().inbox).toEqual([]);
    fs.rmSync(filePath);
  });

  it('admits only the actual persisted byte budget and preserves a readable prior file on overflow', async () => {
    const now = Date.now();
    const filename = 'actual-persisted-budget.json';
    const filePath = path.join(state.base, filename);
    const store = createAnnexDeliveryStore(filename);
    const largeResult = { content: [{ type: 'text' as const, text: '' }] };
    largeResult.content[0].text = 'x'.repeat(65_530 - Buffer.byteLength(JSON.stringify(largeResult)));
    expect(Buffer.byteLength(JSON.stringify(largeResult))).toBeLessThanOrEqual(DELIVERY_MAX_RESULT_BYTES);
    const candidate: DeliveryFile = {
      version: 1, outbox: [], deliveries: [],
      inbox: Array.from({ length: 1020 }, (_, i) => ({ ...receipt(i, now), result: largeResult })),
    };
    const persistedBytes = () => Buffer.byteLength(JSON.stringify(candidate, null, 2));
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(DELIVERY_MAX_BYTES);
    expect(persistedBytes()).toBeGreaterThan(DELIVERY_MAX_BYTES);
    try {
      await store.update((file) => { file.inbox.push(receipt(0, now)); }, now);
      const prior = fs.readFileSync(filePath);
      await expect(store.update((file) => { file.inbox = candidate.inbox; }, now)).rejects.toMatchObject({ code: 'delivery_store_full' });
      expect(fs.readFileSync(filePath).equals(prior)).toBe(true);
      expect(createAnnexDeliveryStore(filename).get().inbox).toHaveLength(1);

      while (persistedBytes() > DELIVERY_MAX_BYTES) candidate.inbox.pop();
      const padding = { ...receipt(2000, now), result: { content: [{ type: 'text' as const, text: '' }] } };
      candidate.inbox.push(padding);
      padding.result.content[0].text = 'x'.repeat(DELIVERY_MAX_BYTES - persistedBytes());
      expect(Buffer.byteLength(JSON.stringify(padding.result))).toBeLessThanOrEqual(DELIVERY_MAX_RESULT_BYTES);
      expect(persistedBytes()).toBe(DELIVERY_MAX_BYTES);
      await store.update((file) => { file.inbox = candidate.inbox; }, now);
      const atLimit = fs.readFileSync(filePath);
      expect(atLimit.byteLength).toBe(DELIVERY_MAX_BYTES);
      expect(createAnnexDeliveryStore(filename).get().inbox).toHaveLength(candidate.inbox.length);
      await expect(store.update((file) => {
        file.inbox[file.inbox.length - 1].result!.content[0].text += 'x';
      }, now)).rejects.toMatchObject({ code: 'delivery_store_full' });
      expect(fs.readFileSync(filePath).equals(atLimit)).toBe(true);
      expect(createAnnexDeliveryStore(filename).get().inbox).toHaveLength(candidate.inbox.length);
    } finally { fs.rmSync(filePath, { force: true }); }
  }, 30_000);

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
