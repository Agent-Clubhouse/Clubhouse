import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
vi.mock('fs', async (original) => { const actual = await original<typeof import('fs')>(); return { ...actual, readSync: vi.fn(actual.readSync) }; });
import { createReadOnlyMetadataBudget, readReadOnlyPrimaryMetadata as readRawMetadata, ReadOnlyMetadataLimitError } from './read-only-agent-target-witness';
const readReadOnlyPrimaryMetadata = (root: string, relative: 'projects.json' | '.clubhouse/agents.json', options: { maxBytes?: number; budget?: ReturnType<typeof createReadOnlyMetadataBudget> } = {}) => readRawMetadata(root, relative, { ...options, budget: options.budget ?? createReadOnlyMetadataBudget() });
let root: string;
const file = () => path.join(root, '.clubhouse', 'agents.json');
const put = (value: unknown) => fs.promises.writeFile(file(), JSON.stringify(value));
beforeEach(async () => { root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-primary-metadata-'))); await fs.promises.mkdir(path.join(root, '.clubhouse')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.promises.rm(root, { recursive: true, force: true }); });
it('reads a private detached primary collection and charges body allocation before creating a final primitive-only witness', async () => {
  await put([{ id: 'target', name: 'Saved target', PRIVATE_ARGS: 'PRIVATE_SOURCE' }]);
  const budget = createReadOnlyMetadataBudget(), bytes = (await fs.promises.stat(file())).size, snapshot = readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json', { budget });
  expect.soft(snapshot.raw).toEqual([{ id: 'target', name: 'Saved target', PRIVATE_ARGS: 'PRIVATE_SOURCE' }]); expect.soft(snapshot.missing).toBe(false); expect.soft(budget.remainingBytes).toBe(8 * 1024 * 1024 - bytes - 1); expect.soft(budget.remainingFiles).toBe(31); expect.soft(snapshot.receipt.current()).toBe(true);
  // This is an INTERNAL raw decoder, not a display DTO. Its caller must apply
  // the selected-field projector; edits never change the source or the witness.
  (snapshot.raw as Array<{ name: string }>)[0].name = 'CALLER_EDIT';
  expect.soft(JSON.parse(await fs.promises.readFile(file(), 'utf8'))[0].name).toBe('Saved target'); expect.soft(snapshot.receipt.current()).toBe(true);
  await put([{ id: 'target', name: 'Later target' }]); expect(snapshot.receipt.current()).toBe(false);
});
it.each(['legacy', 'versioned'] as const)('supports the %s registered-project collection without normalization or recovery', async (mode) => {
  const projects = [{ id: 'project', path: root, name: 'Project' }], raw = mode === 'legacy' ? projects : { version: 1, projects };
  await fs.promises.writeFile(path.join(root, 'projects.json'), JSON.stringify(raw)); const snapshot = readReadOnlyPrimaryMetadata(root, 'projects.json'); expect(snapshot.raw).toEqual(raw); expect(snapshot.receipt.current()).toBe(true);
});
it.each(['files', 'bytes', 'invalid-counter', 'file-size'] as const)('refuses the %s resource bound instead of reading an unbounded collection', async (mode) => {
  await put([]); const budget = createReadOnlyMetadataBudget();
  if (mode === 'files') budget.remainingFiles = 0; if (mode === 'bytes') budget.remainingBytes = 2; if (mode === 'invalid-counter') budget.remainingBytes = Infinity;
  expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json', { budget, ...(mode === 'file-size' ? { maxBytes: 1 } : {}) })).toThrow(ReadOnlyMetadataLimitError);
});
it('distinguishes verified absent agents from a backup-only source and invalidates absence on primary creation', async () => {
  const snapshot = readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json'); expect(snapshot).toMatchObject({ raw: [], missing: true }); expect(snapshot.receipt.current()).toBe(true);
  await put([]); expect(snapshot.receipt.current()).toBe(false); await fs.promises.unlink(file()); await fs.promises.writeFile(file() + '.bak', '[]');
  expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json')).toThrow();
});
it('does not turn an absent registered-project primary or unavailable project directory into a verified empty collection', async () => {
  expect(() => readReadOnlyPrimaryMetadata(root, 'projects.json')).toThrow(); await fs.promises.rm(root, { recursive: true }); expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json')).toThrow();
});
it('refuses invalid UTF-8 and leaves primary/backup/temp bytes untouched', async () => {
  const bytes = Buffer.concat([Buffer.from('[{"id":"target","name":"'), Buffer.from([0xff]), Buffer.from('"}]')]); await fs.promises.writeFile(file(), bytes); await fs.promises.writeFile(file() + '.bak', '[]'); await fs.promises.writeFile(file() + '.tmp-old', 'keep');
  expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json')).toThrow(); expect.soft(await fs.promises.readFile(file())).toEqual(bytes); expect.soft(await fs.promises.readFile(file() + '.bak', 'utf8')).toBe('[]'); expect.soft(await fs.promises.readFile(file() + '.tmp-old', 'utf8')).toBe('keep');
});
it('refuses a real same-path edit during its descriptor read and closes the admitted descriptor', async () => {
  await put([{ id: 'target', name: 'Before' }]); const actual = await vi.importActual<typeof import('fs')>('fs'); let fd: number | undefined, changed = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof actual.readSync>) => { const result = actual.readSync(...args); fd = args[0]; if (!changed) { changed = true; actual.writeFileSync(file(), '[{"id":"target","name":"Changed while reading"}]'); } return result; });
  expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json')).toThrow(); expect(changed).toBe(true); expect(fd).toBeTypeOf('number'); expect(() => actual.fstatSync(fd!)).toThrow();
});
it('rejects non-file metadata and caller-provided arbitrary filenames before decoding', async () => {
  await fs.promises.mkdir(file()); expect(() => readReadOnlyPrimaryMetadata(root, '.clubhouse/agents.json')).toThrow();
  await fs.promises.writeFile(path.join(root, 'private-readable.json'), '[]');
  expect(() => readReadOnlyPrimaryMetadata(root, 'private-readable.json' as never)).toThrow();
  expect(() => readReadOnlyPrimaryMetadata(root, '../unrelated.json' as never)).toThrow(); expect(() => readReadOnlyPrimaryMetadata('../unrelated', 'projects.json')).toThrow();
});

it('requires an explicit aggregate budget at the internal API boundary', async () => { await put([]); expect(() => readRawMetadata(root, '.clubhouse/agents.json', {} as never)).toThrow(ReadOnlyMetadataLimitError); });
