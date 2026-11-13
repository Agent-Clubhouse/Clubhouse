import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { summarizeHandoffManifest } from '../../shared/handoff-manifest';
import { isTerminalHandoff, type Handoff, type HandoffManifestSummary } from '../../shared/handoffs';
import { createSettingsStore, type SettingsStore } from './settings-store';
import { callerHandoffSource } from './handoff-preflight-host';
import { prepareHandoffTransfer } from './handoff-transfer-preparation';
import { readHandoffSnapshotManifest, type PrepareHandoffSnapshot } from './handoff-snapshot';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TTL = 15 * 60_000;
interface Preparation {
  id: string; owner: string; project: string; mode: 'branch' | 'worktree'; at: number;
  summary: HandoffManifestSummary; boundTo: string[];
}
interface Catalog { v: 1; entries: Preparation[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function parse(raw: unknown): Catalog {
  if (!object(raw) || raw.v !== 1 || Object.keys(raw).some((key) => !['v', 'entries'].includes(key)) || !Array.isArray(raw.entries) || raw.entries.length > 512) throw new Error('Invalid handoff preparation catalog.');
  const ids = new Set<string>(); const bindings = new Set<string>(); let bytes = 0;
  for (const value of raw.entries) {
    if (!object(value) || Object.keys(value).some((key) => !['id', 'owner', 'project', 'mode', 'at', 'summary', 'boundTo'].includes(key))
      || typeof value.id !== 'string' || !UUID.test(value.id) || ids.has(value.id)
      || typeof value.owner !== 'string' || !value.owner || value.owner.length > 128 || typeof value.project !== 'string' || !value.project || value.project.length > 128
      || !['branch', 'worktree'].includes(value.mode as string) || !Number.isSafeInteger(value.at) || (value.at as number) < 0
      || !object(value.summary) || Object.keys(value.summary).some((key) => !['fileCount', 'totalBytes', 'sha256'].includes(key))
      || !Number.isSafeInteger(value.summary.fileCount) || (value.summary.fileCount as number) < 0 || (value.summary.fileCount as number) > 10_000
      || !Number.isSafeInteger(value.summary.totalBytes) || (value.summary.totalBytes as number) < 0 || (value.summary.totalBytes as number) > 16 * 1024 ** 3
      || typeof value.summary.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.summary.sha256)
      || !Array.isArray(value.boundTo) || value.boundTo.length > 512) throw new Error('Invalid handoff preparation entry.');
    ids.add(value.id); bytes += value.summary.totalBytes as number;
    for (const id of value.boundTo) { if (typeof id !== 'string' || !UUID.test(id) || bindings.has(id)) throw new Error('Invalid handoff preparation binding.'); bindings.add(id); }
  }
  if (bytes > 64 * 1024 ** 3) throw new Error('Handoff preparation storage capacity reached.');
  return structuredClone(raw) as unknown as Catalog;
}
class PreparationStore {
  private readonly disk: SettingsStore<Catalog>;
  private committed?: Catalog;
  private unreadable = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor() {
    this.disk = createSettingsStore<Catalog>('handoff-preparations.json', { v: 1, entries: [] }, parse, {
      atomic: true, mode: 0o600, rollBackFailedSaves: true,
      onLoad: (result) => {
        if ('error' in result) this.unreadable = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
        else { try { parse(JSON.parse(result.raw)); } catch { this.unreadable = true; /* telemetry-exempt: corrupt preparation state fails closed */ } }
      },
    });
  }
  list(): Preparation[] {
    if (!this.committed) { const raw = this.disk.get(); if (this.unreadable) throw new Error('Handoff preparations are unreadable.'); this.committed = parse(raw); }
    return structuredClone(this.committed.entries);
  }
  change(update: (entries: Preparation[]) => void): Promise<void> {
    const work = async () => { const entries = this.list(); update(entries); const next = parse({ v: 1, entries }); await this.disk.save(next); this.committed = next; };
    const result = this.pending.then(work, work); this.pending = result; return result;
  }
}
let singleton: PreparationStore | undefined;
const store = () => singleton ??= new PreparationStore();
const inFlightBindings = new Set<string>();
const allocated = new Set<string>();
const preparing = new Map<string, Promise<unknown>>();
function sameSummary(a: HandoffManifestSummary, b: HandoffManifestSummary): boolean { return !!b && a.fileCount === b.fileCount && a.totalBytes === b.totalBytes && a.sha256 === b.sha256; }
async function preparationRoot(): Promise<string> {
  let root = await fs.promises.realpath(app.getPath('userData'));
  for (const part of ['handoff-data', 'prepared']) {
    const next = path.join(root, part);
    try { await fs.promises.mkdir(next, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.promises.lstat(next);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(next) !== next) throw new Error('Invalid handoff preparation directory.');
    root = next;
  }
  return root;
}

export async function prepareCallerHandoff(owner: string, mode: 'branch' | 'worktree', selection: Pick<PrepareHandoffSnapshot, 'include' | 'exclude'> = {}) {
  const prior = preparing.get(owner);
  const work = (async () => {
    try { await prior; } catch { /* telemetry-exempt: a previous preparation failure does not block a new selection */ }
    const source = await callerHandoffSource(owner); const root = await preparationRoot(); const id = randomUUID();
    allocated.add(id);
    try {
      const snapshot = await prepareHandoffTransfer({ ...selection, mode, worktreeRoot: source.worktreeRoot, stagingRoot: root, handoffId: id, bounds: source.bounds, secretPolicy: source.secretPolicy });
      const summary = summarizeHandoffManifest(snapshot.manifest); const retired: string[] = [];
      try {
        await store().change((entries) => {
          for (let index = entries.length - 1; index >= 0; index--) if (!entries[index].boundTo.length && (entries[index].owner === owner || Date.now() - entries[index].at >= TTL)) retired.push(entries.splice(index, 1)[0].id);
          entries.push({ id, owner, project: source.project.id, mode, at: Date.now(), summary, boundTo: [] });
        });
      } catch (error) { await fs.promises.rm(snapshot.root, { recursive: true, force: true }); throw error; }
      for (const old of retired) await fs.promises.rm(path.join(root, old), { recursive: true, force: true });
      return { ready: true as const, manifest: snapshot.manifest, summary, bounds: source.bounds };
    } finally { allocated.delete(id); }
  })();
  preparing.set(owner, work);
  try { return await work; } finally { if (preparing.get(owner) === work) preparing.delete(owner); }
}

/** An offer may reference only this agent's own frozen, registered-project preparation. */
export async function ensurePreparedHandoff(owner: string, mode: 'branch' | 'worktree', summary?: HandoffManifestSummary): Promise<HandoffManifestSummary> {
  if (!summary) return (await prepareCallerHandoff(owner, mode)).summary;
  const source = await callerHandoffSource(owner);
  const entry = store().list().find((item) => item.owner === owner && item.project === source.project.id && item.mode === mode && sameSummary(item.summary, summary) && (item.boundTo.length || Date.now() - item.at < TTL));
  if (!entry) throw new Error('Prepare this selection again before offering it.');
  await readHandoffSnapshotManifest(path.join(await preparationRoot(), entry.id), entry.summary, source.bounds);
  return entry.summary;
}

/** Runs inside the offer's before-commit boundary, so no visible offer lacks its durable source. */
export async function bindPreparedHandoff(record: Handoff): Promise<void> {
  if (!record.manifest) throw new Error('Handoff has no prepared manifest.');
  const source = await callerHandoffSource(record.from.agentId);
  inFlightBindings.add(record.id);
  try {
    await store().change((entries) => {
      const entry = entries.find((item) => item.owner === record.from.agentId && item.project === source.project.id && item.mode === record.mode && sameSummary(item.summary, record.manifest!) && (item.boundTo.length || Date.now() - item.at < TTL));
      if (!entry) throw new Error('Handoff preparation expired or belongs to another agent.');
      if (!entry.boundTo.includes(record.id)) entry.boundTo.push(record.id);
    });
  } catch (error) { inFlightBindings.delete(record.id); throw error; }
}
export function settleHandoffPreparationBinding(id: string): void { inFlightBindings.delete(id); }

export async function preparedSourceForRecord(record: Handoff) {
  if (!record.manifest) throw new Error('This handoff must be prepared and offered again.');
  const source = await callerHandoffSource(record.from.agentId);
  const entry = store().list().find((item) => item.owner === record.from.agentId && item.project === source.project.id && item.mode === record.mode && item.boundTo.includes(record.id) && sameSummary(item.summary, record.manifest!));
  if (!entry) throw new Error('Prepared handoff bytes are unavailable.');
  const root = path.join(await preparationRoot(), entry.id);
  const manifest = await readHandoffSnapshotManifest(root, entry.summary, source.bounds);
  return { snapshot: { root, manifest }, source };
}

export async function pruneHandoffPreparations(records: readonly Handoff[]): Promise<void> {
  const byId = new Map(records.map((record) => [record.id, record])); const removed: string[] = [];
  await store().change((entries) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]; const wasBound = entry.boundTo.length > 0;
      entry.boundTo = entry.boundTo.filter((id) => inFlightBindings.has(id) || (byId.has(id) ? !isTerminalHandoff(byId.get(id)!.state) : Date.now() - entry.at < TTL));
      if (!entry.boundTo.length && (wasBound || Date.now() - entry.at >= TTL)) removed.push(entries.splice(index, 1)[0].id);
    }
  });
  const root = await preparationRoot();
  for (const id of removed) await fs.promises.rm(path.join(root, id), { recursive: true, force: true });
  const retained = new Set(store().list().map((entry) => entry.id));
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!UUID.test(entry.name) || retained.has(entry.name) || allocated.has(entry.name)) continue;
    const orphan = path.join(root, entry.name); const stat = await fs.promises.lstat(orphan);
    if (Date.now() - stat.mtimeMs >= TTL) await fs.promises.rm(orphan, { recursive: true, force: true });
  }
}
export function _resetHandoffPreparationsForTesting(): void { singleton = undefined; inFlightBindings.clear(); allocated.clear(); preparing.clear(); }
