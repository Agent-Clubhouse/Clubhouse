import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
import { readAgentPage, remoteDispatcherPageName, writeAgentNotes } from './dispatcher-memory';
import { peerCardText, syncPeerPages, watchPeerPages } from './dispatcher-peer-pages';

let base: string;
let root: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-pages-'));
  root = path.join(base, 'memory');
  fs.mkdirSync(root);
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const FP = 'ab:cd:ef:01:23';
const remote = (extra: Partial<RemoteDispatcherPresence> = {}): RemoteDispatcherPresence => ({
  machineId: FP, machineName: 'Desk', address: `controller@${FP}`, dispatcherName: 'Studio', label: 'Studio on Desk',
  state: 'online', link: { state: 'active' }, ...extra,
});

describe('memory pages for other computers\' Dispatchers (#3349)', () => {
  it('keys the page by a Windows-safe hash of the machine-qualified address and titles it by label', async () => {
    const name = remoteDispatcherPageName(`controller@${FP}`);
    expect(name).toMatch(/^peer-[0-9a-f]{16}$/);
    expect(remoteDispatcherPageName(`CONTROLLER@${FP.toUpperCase()}`)).toBe(name);
    expect(await syncPeerPages([remote()], root)).toBe(1);
    const text = fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8');
    expect(text.split('\n')[0]).toBe('# Studio on Desk');
    expect(text).toContain(`Address: controller@${FP}`);
    expect(fs.readdirSync(path.join(root, 'agents')).every((f) => !f.includes(':'))).toBe(true);
  });

  it('rewrites only when the stable facts change, keeping the Dispatcher\'s notes, and never for state alone', async () => {
    await syncPeerPages([remote()], root);
    const name = remoteDispatcherPageName(`controller@${FP}`);
    await writeAgentNotes(name, 'Prefers short requests.', root);
    expect(await syncPeerPages([remote({ state: 'working' }), remote({ machineId: 'x', address: null, label: 'Dispatcher on X' })], root)).toBe(0);
    expect(await syncPeerPages([remote({ dispatcherName: 'Atelier', label: 'Atelier on Desk' })], root)).toBe(1);
    const page = await readAgentPage(name, root);
    expect(page).toEqual({ card: peerCardText({ ...remote({ dispatcherName: 'Atelier' }), address: `controller@${FP}` }), notes: 'Prefers short requests.' });
    expect(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8').split('\n')[0]).toBe('# Atelier on Desk');
    // The Dispatcher's own notes write keeps the label heading, never the hashed name.
    await writeAgentNotes(name, 'Prefers short requests. Mornings only.', root);
    expect(fs.readFileSync(path.join(root, 'agents', `${name}.md`), 'utf8').split('\n')[0]).toBe('# Atelier on Desk');
  });

  it('writes only while the Dispatcher is on, and follows presence changes', async () => {
    let enabled = false;
    let changed: (() => void) | undefined;
    let remotes = [remote()];
    const stop = watchPeerPages({ remotes: () => remotes, enabled: () => enabled, onChanged: (l) => { changed = l; return () => { changed = undefined; }; }, root });
    const name = remoteDispatcherPageName(`controller@${FP}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readAgentPage(name, root)).toBeNull();
    enabled = true;
    remotes = [remote({ dispatcherName: 'Atelier', label: 'Atelier on Desk' })];
    changed?.();
    await vi.waitFor(async () => expect((await readAgentPage(name, root))?.card).toContain('Atelier is the Dispatcher on Desk'));
    stop();
    expect(changed).toBeUndefined();
  });
});
