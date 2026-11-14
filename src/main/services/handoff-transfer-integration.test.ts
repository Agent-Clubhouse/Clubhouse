import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeEach as rawBeforeEach, expect, it as rawIt, vi } from 'vitest';
import { CheckpointFixtureLifetime } from '../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration } from '../../../test/dispatcher-work-owner';
const state = vi.hoisted(() => ({ data: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.data } }));
import { HANDOFF_TRANSFER_DEFAULTS, summarizeHandoffManifest } from '../../shared/handoff-manifest';
import { parseHandoff } from '../../shared/handoffs';
import { prepareHandoffTransfer } from './handoff-transfer-preparation';
import { HandoffTransferSource } from './handoff-transfer-source';
import { HandoffStore } from './handoff-store';
import { HandoffService } from './handoff-service';
import { HandoffWorker } from './handoff-worker';
const lifetime = vi.hoisted(() => ({ current: undefined as CheckpointFixtureLifetime | undefined, directory: '' }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../test/checkpoint-fixture-lifetime');
  return { ...actual, execFile: ownCheckpointExecFile(actual.execFile, () => lifetime.current) };
});
function owner(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('Handoff fixture is missing');
  return lifetime.current;
}
const it = ownedRegistration(rawIt, 1, (promise) => { owner().observeRaw(promise); });
const beforeEach = ownedRegistration(rawBeforeEach, 0, (promise) => { owner().observeRaw(promise); });
const exec = promisify(execFile);
const receiverMachine = Array(16).fill('ab').join(':');
let root: string; let sender: string; let receiver: string; let outgoing: string; let incoming: string;
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd });
async function initialize(repo: string, content: string) {
  fs.mkdirSync(repo); await git(repo, 'init', '-b', 'main'); await git(repo, 'config', 'user.name', 'Fixture'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'work.txt'), content); fs.writeFileSync(path.join(repo, '.gitignore'), 'fixtures/\n.clubhouse/\n');
  await git(repo, 'add', '.'); await git(repo, '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'Base');
  await git(repo, 'config', 'remote.origin.url', 'https://example.invalid/project.git');
}
beforeEach(async () => {
  lifetime.current?.assertRetired(); lifetime.current = new CheckpointFixtureLifetime();
  lifetime.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-integration-'));
  // Async realpath expands Windows DOS 8.3 aliases just as the production roots do.
  root = await fs.promises.realpath(lifetime.directory); state.data = root;
  sender = path.join(root, 'sender'); receiver = path.join(root, 'receiver'); outgoing = path.join(root, 'outgoing'); incoming = path.join(root, 'incoming');
  fs.mkdirSync(outgoing); fs.mkdirSync(incoming);
  const config = path.join(root, 'empty-config'); fs.writeFileSync(config, ''); vi.stubEnv('GIT_CONFIG_GLOBAL', config); vi.stubEnv('GIT_CONFIG_SYSTEM', config); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
  await initialize(sender, 'sender base'); await initialize(receiver, 'receiver base');
  await git(receiver, 'config', `url.${pathToFileURL(path.join(root, 'absent.git')).href}.insteadOf`, 'https://example.invalid/project.git');
});
afterEach(async () => {
  await owner().close(() => Promise.resolve(), () => {
    vi.unstubAllEnvs(); fs.rmSync(lifetime.directory, { recursive: true, force: true });
  });
});
afterAll(() => { lifetime.current?.assertRetired(); });
it.each(['same-machine', 'paired-computer'])('automatically applies a %s accepted handoff and wakes only after verified publication', async (kind) => {
  fs.writeFileSync(path.join(sender, 'work.txt'), 'final tracked bytes'); fs.writeFileSync(path.join(sender, 'new.txt'), 'new untracked');
  fs.mkdirSync(path.join(sender, 'fixtures')); const large = Buffer.alloc(600 * 1024, 17);
  fs.writeFileSync(path.join(sender, 'fixtures', 'selected.bin'), large); fs.writeFileSync(path.join(sender, 'fixtures', 'excluded.bin'), 'not selected');
  fs.writeFileSync(path.join(receiver, 'work.txt'), 'person dirty work');
  const id = randomUUID(); const bounds = HANDOFF_TRANSFER_DEFAULTS;
  const snapshot = await prepareHandoffTransfer({ worktreeRoot: sender, stagingRoot: outgoing, handoffId: id, mode: 'worktree', bounds, include: { ignored: ['fixtures/selected.bin'] } });
  const senderMachine = kind === 'same-machine' ? receiverMachine : Array(16).fill('cd').join(':');
  const from = { machine: senderMachine, agentId: 'sender' }; const to = { machine: receiverMachine, agentId: 'receiver' }; const at = Date.now();
  let senderRecord = parseHandoff({ schemaVersion: 1, id, from, to, task: { title: 'Continue', brief: 'Finish in the new worktree' }, mode: 'worktree', manifest: summarizeHandoffManifest(snapshot.manifest), state: 'offered', version: 1, createdAt: at, updatedAt: at,
    history: [{ state: 'offered', operationId: randomUUID(), at, by: { kind: 'agent', address: from } }] });
  const store = new HandoffStore(); const service = new HandoffService({ machine: receiverMachine, store, authorize: async () => true, isDispatcher: () => false });
  await service.receiveOffer(senderRecord, senderMachine); await service.respond(id, to, true, 1);
  senderRecord = store.get(id)!;
  const source = new HandoffTransferSource({ machine: senderMachine, record: () => kind === 'same-machine' ? store.get(id) : senderRecord, authorize: async () => {}, prepared: async () => ({ snapshot, source: { bounds } }) });
  const wake = vi.fn(async (_record, result, admission) => {
    expect(admission()).toBe(true); expect(store.get(id)?.state).toBe('applying');
    expect(fs.readFileSync(path.join(result.worktree, 'work.txt'), 'utf8')).toBe('final tracked bytes');
    expect(fs.readFileSync(path.join(result.worktree, 'fixtures', 'selected.bin'))).toEqual(large);
    expect(fs.existsSync(path.join(result.worktree, 'fixtures', 'excluded.bin'))).toBe(false);
    expect(fs.readFileSync(path.join(receiver, 'work.txt'), 'utf8')).toBe('person dirty work');
  });
  const worker = new HandoffWorker({ machine: receiverMachine, records: () => store.list(), advance: (record, update) => service.advance(id, update, record.version),
    authorize: async () => {}, resolve: async () => ({ projectId: 'registered', projectRoot: receiver, bounds }), stagingRoot: async () => incoming,
    sync: async () => { senderRecord = store.get(id)!; }, request: (_record, request) => source.receive(receiverMachine, request), wake });
  try {
    await worker.run(id);
    const result = new HandoffStore().get(id)!;
    expect(result.state).toBe('applied'); expect(wake).toHaveBeenCalledTimes(1);
    expect(result.result?.commit).toBe(snapshot.manifest.repo.base); expect(result.result?.worktree).not.toBe(receiver);
    expect((await git(result.result!.worktree, 'status', '--porcelain')).stdout).toContain(' M work.txt');
    expect(fs.readdirSync(incoming)).toEqual([]);
    await worker.run(id); expect(wake).toHaveBeenCalledTimes(1);
  } finally { await worker.stop(); await source.close(); }
}, 60_000);
