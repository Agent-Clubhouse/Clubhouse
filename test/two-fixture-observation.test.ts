import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FixtureObservationSelection, observeCleanupBatch, observeSeedCleanup, readObservationLines, type ObservationDependencies, type ObservationSlot } from './two-fixture-observation';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(dependencies: Partial<ObservationDependencies> = {}) {
  const lines: string[] = []; const timers: Array<{ callback(): void; ms: number; unref: number; clear: number }> = [];
  const selection = new FixtureObservationSelection('pages-large', {
    clock: () => 10, sink: (line) => { lines.push(line); },
    setTimer: (callback, ms) => { const timer = { callback, ms, unref: 0, clear: 0 }; timers.push(timer); return timer; },
    unrefTimer: (handle) => { (handle as typeof timers[number]).unref++; },
    clearTimer: (handle) => { (handle as typeof timers[number]).clear++; }, ...dependencies,
  });
  return { lines, timers, selection, scope: selection.claim()! };
}
const allSlots: ObservationSlot[] = ['entry', 'pre-deadline', 'body-settlement', 'cleanup-boundary', 'cleanup-entry', 'cleanup-settlement'];

describe('two-fixture observation contract', () => {
  it('returns original Promise/value/error and invokes synchronously once with captured receiver/arguments', async () => {
    const { scope } = harness(); const operation = deferred<object>(); const receiver = {}; const argument = {};
    let count = 0;
    function original(this: unknown, input: object) { expect(this).toBe(receiver); expect(input).toBe(argument); count++; return operation.promise; }
    expect(scope.call('catalog', () => Reflect.apply(original, receiver, [argument]))).toBe(operation.promise);
    expect(count).toBe(1); const value = {}; operation.resolve(value); expect(await operation.promise).toBe(value);
    expect(scope.call('revision', () => value)).toBe(value);
    const error = Object.assign(new Error('private-canary'), { code: 'EACCES' });
    const rejected = Promise.reject(error); expect(scope.call('install', () => rejected)).toBe(rejected);
    await expect(rejected).rejects.toBe(error);
    expect(() => scope.call('catalog', () => { throw error; })).toThrow(error);
    expect(scope.read()).toMatchObject({ rejectedInstalls: 1, errorCategory: 'native-denied' });
  });

  it('keeps outer pending facets independent, caught rejection sticky, and extra/overlap inconclusive', async () => {
    const { scope, selection } = harness(); const body = deferred<void>(); const ensure = deferred<void>(); const install = deferred<void>();
    scope.call('body', () => body.promise); scope.call('ensure', () => ensure.promise); scope.call('install', () => install.promise, 'block');
    await scope.call('catalog', () => Promise.resolve());
    expect(scope.read()).toMatchObject({ body: 'pending', ensure: 'pending', install: 'pending', catalog: 'fulfilled' });
    install.reject(new Error('synthetic')); await expect(install.promise).rejects.toThrow();
    await scope.call('install', () => Promise.resolve(), 'skill');
    expect(scope.read()).toMatchObject({ rejectedInstalls: 1, fulfilledInstalls: 1, ensure: 'pending' });
    const overlap = deferred<void>(); scope.call('catalog', () => overlap.promise); scope.call('catalog', (): void => undefined);
    expect(scope.read().catalog).toBe('pending'); expect(selection.claim()).toBeUndefined();
    expect(selection.selected).toBe(scope); expect(scope.read()).toMatchObject({ overlap: true, extraInvocation: true });
    overlap.resolve(); ensure.resolve(); body.resolve(); await body.promise;
  });

  it('caps scalar counts and output without retaining payloads or invoking getters/toJSON', () => {
    const { scope, lines } = harness();
    const canary = { get code() { throw new Error('secret-getter'); }, toJSON() { throw new Error('secret-json'); } };
    expect(() => scope.call('install', () => { throw canary; })).toThrow();
    for (let n = 0; n < 65536; n++) scope.call('install', (): void => undefined, 'template');
    for (const slot of allSlots) { scope.publish(slot); scope.publish(slot); }
    expect(scope.read()).toMatchObject({ enteredInstalls: 65535, fulfilledInstalls: 65535, rejectedInstalls: 1, overflow: true });
    expect(lines).toHaveLength(6); expect(lines.every((line) => Buffer.byteLength(line) <= 1536)).toBe(true);
    expect(lines.join('')).not.toMatch(/secret|private|toJSON/);
    expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(9216);
  });

  it.each(['clock', 'beforeBuild', 'serialize', 'sink', 'classify'] as const)('contains %s throw and reentry with once-reserved slots and original failure', async (dependency) => {
    for (const throws of [true, false]) {
      let first = true; const lines: string[] = [];
      const callback = () => { if (first) { first = false; if (throws) throw new Error('sensitive-canary'); scope.publish('pre-deadline'); } };
      const h = harness({
        clock: () => { if (dependency === 'clock') callback(); return 1; },
        beforeBuild: () => { if (dependency === 'beforeBuild') callback(); },
        serialize: (row) => { if (dependency === 'serialize') callback(); return JSON.stringify(row); },
        sink: (line) => { if (dependency === 'sink') callback(); lines.push(line); },
        classify: () => { if (dependency === 'classify') callback(); return 'unknown'; },
      }); const scope = h.scope;
      const error = new Error('sensitive-canary'); const actual = Promise.reject(error);
      expect(scope.call('body', () => actual)).toBe(actual); await expect(actual).rejects.toBe(error);
      for (const slot of allSlots) scope.publish(slot);
      expect(lines.length).toBeLessThanOrEqual(6); expect(lines.every((line) => Buffer.byteLength(line) <= 1536)).toBe(true);
      expect(lines.join('')).not.toContain('sensitive-canary');
      const rows = readObservationLines(lines.join(''), 'pages-large');
      expect(new Set(rows.rows.map((row) => row.sequence)).size).toBe(rows.rows.length);
      if (throws || dependency !== 'classify') expect(scope.read().observerFault).toBe(true);
    }
  });

  it('binds its first scope before optional reentry and never adopts the extra invocation', () => {
    let first = true; let calls = 0;
    const selection = new FixtureObservationSelection('auto-seed', {
      clock: () => { if (first) { first = false; expect(selection.claim()).toBeUndefined(); } return 1; },
      sink: () => {}, setTimer: () => ({}), unrefTimer: () => {}, clearTimer: () => {},
    });
    const scope = selection.claim()!; const store = {}; scope.bindStore(store);
    scope.call('body', () => { calls++; return 1; });
    expect(calls).toBe(1); expect(selection.selected).toBe(scope); expect(scope.ownsStore(store)).toBe(true);
    expect(scope.read()).toMatchObject({ extraInvocation: true, overlap: true, body: 'fulfilled' });
  });

  it('does not let an older classifier overwrite a newer reentrant error', () => {
    let first = true;
    const newer = new Error('newer-private'); const older = new Error('older-private');
    const h = harness({ classify: (error) => {
      if (first) { first = false; expect(() => scope.call('revision', () => { throw newer; })).toThrow(newer); }
      return error === newer ? 'native-busy' : 'native-denied';
    } }); const scope = h.scope;
    expect(() => scope.call('catalog', () => { throw older; })).toThrow(older);
    expect(scope.read()).toMatchObject({ observerFault: true, errorCategory: 'native-busy' });
  });

  it('captures mutable seed arguments before sink reentry and preserves sync cleanup value/error', () => {
    let seed = 'first'; let calls = 0; const h = harness({ sink: () => { seed = 'second'; } }); h.scope.bindDirectory(seed);
    const captured = seed; const value = {};
    expect(observeSeedCleanup(h.selection, captured, () => { calls++; expect(captured).toBe('first'); return value; })).toBe(value);
    expect(calls).toBe(1); expect(seed).toBe('second');
    const error = new Error('cleanup');
    expect(() => observeSeedCleanup(h.selection, seed, () => { throw error; })).toThrow(error);
    expect(h.scope.read()).toMatchObject({ cleanupMatch: 'mismatch', observerFault: true });
  });

  it('preserves one captured cleanup batch, rm Promise identity/order/concurrency and aggregate first rejection', async () => {
    const homes = ['selected', 'other']; const task = {}; const selected = deferred<void>(); const other = deferred<void>();
    const h = harness({ sink: () => { homes.push('late'); } }); h.scope.bindTask(task); h.scope.bindDirectory('selected');
    const batch = homes.splice(0); const entered: string[] = [];
    const aggregate = observeCleanupBatch(h.selection, task, batch, (directory) => {
      const original = directory === 'selected' ? selected.promise : other.promise;
      return () => { entered.push(directory); return original; };
    });
    expect(entered).toEqual(['selected', 'other']); expect(homes.every((home) => home === 'late')).toBe(true);
    const error = new Error('other failed'); other.reject(error); await expect(aggregate).rejects.toBe(error);
    expect(h.scope.read()).toMatchObject({ cleanup: 'pending', aggregate: 'rejected' });
    selected.resolve(); await selected.promise; expect(h.scope.read().cleanup).toBe('fulfilled');
  });

  it('records late home as absent from first actual batch and only observes later actual matching cleanup', async () => {
    const h = harness(); const task = {}; h.scope.bindTask(task); let count = 0;
    await observeCleanupBatch(h.selection, task, [], () => () => { count++; return Promise.resolve(); });
    expect(h.scope.read()).toMatchObject({ cleanupMatch: 'not-known', cleanup: 'none' });
    h.scope.bindDirectory('late-home');
    await observeCleanupBatch(h.selection, {}, ['unrelated'], () => () => { count++; return Promise.resolve(); });
    expect(h.scope.read().cleanup).toBe('none');
    await observeCleanupBatch(h.selection, {}, ['late-home'], () => () => { count++; return Promise.resolve(); });
    expect(count).toBe(2); expect(h.scope.read()).toMatchObject({ cleanup: 'fulfilled', cleanupMatch: 'matched' });
    const unmatched = harness(); unmatched.scope.bindTask({}); unmatched.scope.bindDirectory('missing');
    await observeCleanupBatch(unmatched.selection, {}, [], () => () => Promise.resolve());
    expect(unmatched.scope.read().cleanup).toBe('none');
  });

  it('claims one unref timer, clears on actual settlement/sync throw and ignores a queued callback after clear', async () => {
    const h = harness(); const body = deferred<void>(); h.scope.call('body', () => body.promise);
    expect(h.timers).toHaveLength(1); expect(h.timers[0]).toMatchObject({ ms: 29000, unref: 1, clear: 0 });
    body.resolve(); await body.promise; expect(h.timers[0].clear).toBe(1);
    h.timers[0].callback(); expect(h.lines.join('')).not.toContain('pre-deadline');
    const sync = harness(); expect(() => sync.scope.call('body', () => { throw new Error('body'); })).toThrow('body');
    expect(sync.timers[0].clear).toBe(1);
    for (const failure of ['setTimer', 'unrefTimer', 'clearTimer'] as const) {
      const failed = harness({ [failure]: () => { throw new Error('timer'); } }); const value = {};
      expect(failed.scope.call('body', () => value)).toBe(value); expect(failed.scope.read().observerFault).toBe(true);
    }
  });

  it('advances progress only after the original await resumes and never serializes captured identity', async () => {
    const h = harness(); const update = deferred<object>(); const root = {}; const store = { secret: 'identity-canary' };
    h.scope.bindStore(store); h.scope.bindTask(store); h.scope.bindDirectory('identity-canary');
    h.scope.setPhase('updates'); h.scope.updateStarted(1);
    const actual = (async () => { const result = await update.promise; expect(result).toBe(root); h.scope.updateCompleted(1); })();
    expect(h.scope.read().completedUpdates).toBe(0); update.resolve(root);
    expect(h.scope.read().completedUpdates).toBe(0); await actual; expect(h.scope.read().completedUpdates).toBe(1);
    h.scope.publish('entry'); expect(h.lines.join('')).not.toContain('identity-canary');
    const partial = harness({ serialize: () => 'identity-canary' }); partial.scope.publish('entry'); partial.scope.publish('entry');
    expect(partial.lines).toEqual([]); expect(partial.scope.read().observerFault).toBe(true);
  });

  it('treats missing/wrong-scope/gaps/clock loss as unavailable, never as functional success', () => {
    const h = harness(); allSlots.forEach((slot) => h.scope.publish(slot));
    expect(readObservationLines(h.lines.join(''), 'pages-large').available).toBe(true);
    expect(readObservationLines(h.lines.slice(1).join(''), 'pages-large').available).toBe(false);
    expect(readObservationLines(h.lines.join(''), 'auto-seed').available).toBe(false);
    expect(readObservationLines(h.lines.join('') + h.lines[0], 'pages-large').available).toBe(false);
    const bad = harness({ clock: () => Number.NaN }); bad.scope.publish('entry');
    expect(readObservationLines(bad.lines.join(''), 'pages-large', ['entry'])).toMatchObject({ available: false });
    expect(bad.lines.join('')).toContain('unavailable');
  });
});

// Actual public TestContext.task identity crosses into its own real afterEach.
describe('two-fixture observation public task contract', () => {
  const h = harness(); let task: object; let cleanup = 0;
  afterEach(async (context) => {
    expect(context.task).toBe(task);
    await observeCleanupBatch(h.selection, context.task, ['public-home'], () => () => { cleanup++; return Promise.resolve(); });
    expect(cleanup).toBe(1); expect(h.scope.read()).toMatchObject({ cleanup: 'fulfilled', cleanupMatch: 'matched' });
  });
  it('links actual task before first await without passing signal into work', (context) => {
    task = context.task; h.scope.bindTask(task, () => context.signal.aborted); h.scope.bindDirectory('public-home');
    const actual = Promise.resolve(); expect(h.scope.call('body', () => actual)).toBe(actual); return actual;
  });
});

it('two-fixture observation real deadline/late transport contract', async () => {
  const base = process.env.CLUBHOUSE_FIXTURE_PROOF_DIR ?? os.tmpdir();
  const directory = await fs.mkdtemp(path.join(base, 'deadline-transport-'));
  const helper = path.resolve('test/two-fixture-observation.ts');
  const vitest = path.resolve('node_modules/vitest/dist/index.js');
  const common = `import {beforeAll,afterAll,afterEach,describe,it,expect} from ${JSON.stringify(vitest)};\nimport {FixtureObservationSelection,observeCleanupBatch,observeSeedCleanup} from ${JSON.stringify(helper)};\n`;
  const seed = common + `
const selection=new FixtureObservationSelection('auto-seed'); const scope=selection.claim(); scope.bindDirectory('seed'); let settled=false; let cleanup=0;
describe('original hook deadline',()=>{
 beforeAll(()=>scope.call('body',()=>new Promise(resolve=>setTimeout(()=>{settled=true;resolve();},10080))));
 afterAll(()=>{const captured='seed'; return observeSeedCleanup(selection,captured,()=>{cleanup++;expect(settled).toBe(false);});});
 it('original migration body cannot run after failed hook',()=>{throw new Error('unreached');});
});
it('independent later case sees actual late hook settlement',async()=>{expect(cleanup).toBe(1);await new Promise(resolve=>setTimeout(resolve,250));expect(settled).toBe(true);expect(scope.read().body).toBe('fulfilled');});
`;
  const pages = common + `
const selection=new FixtureObservationSelection('pages-large'); const scope=selection.claim(); let settled=false;let cleanup=0;let task;
afterEach(context=>{if(context.task!==task)return;const batch=['home'];return observeCleanupBatch(selection,context.task,batch,()=>()=>{cleanup++;expect(settled).toBe(false);return Promise.resolve();});});
it('original pages deadline',context=>{task=context.task;scope.bindTask(task,()=>context.signal.aborted);scope.bindDirectory('home');return scope.call('body',()=>new Promise(resolve=>setTimeout(()=>{settled=true;resolve();},30080)));},30000);
it('independent later case sees actual late pages settlement',async()=>{expect(cleanup).toBe(1);await new Promise(resolve=>setTimeout(resolve,250));expect(settled).toBe(true);expect(scope.read().body).toBe('fulfilled');});
`;
  await fs.writeFile(path.join(directory, 'seed.test.ts'), seed); await fs.writeFile(path.join(directory, 'pages.test.ts'), pages);
  await fs.writeFile(path.join(directory, 'vitest.config.mjs'), `export default {test:{include:['*.test.ts'],environment:'node',maxWorkers:1,hookTimeout:10000,reporters:['default','junit'],outputFile:{junit:${JSON.stringify(path.join(directory, 'junit.xml'))}}}};`);
  const args = [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--config', path.join(directory, 'vitest.config.mjs')];
  const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, args, { cwd: process.cwd(), timeout: 65000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error as NodeJS.ErrnoException).code ?? 'unknown' : 0, stdout, stderr });
    });
  });
  await fs.writeFile(path.join(directory, 'raw-stdout.txt'), result.stdout); await fs.writeFile(path.join(directory, 'raw-stderr.txt'), result.stderr);
  await fs.writeFile(path.join(directory, 'invocation.json'), JSON.stringify({ executable: process.execPath, args, code: result.code, directory }, null, 2));
  const xml = await fs.readFile(path.join(directory, 'junit.xml'), 'utf8');
  expect(result.code).toBe(1); expect(result.stderr).toContain('Hook timed out in 10000ms'); expect(result.stderr).toContain('Test timed out in 30000ms');
  expect(result.stdout + result.stderr).not.toMatch(/Unhandled|unhandled rejection|Worker exited unexpectedly/);
  const availability: Record<string, unknown> = {};
  for (const tag of ['auto-seed', 'pages-large'] as const) {
    const raw = readObservationLines(result.stdout, tag); const junit = readObservationLines(xml.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'), tag);
    availability[tag] = { raw: raw.rows, rawAvailable: raw.available, junit: junit.rows, junitAvailable: junit.available };
    expect(raw.available).toBe(true); expect(raw.rows.find((row) => row.event === 'pre-deadline')?.body).toBe('pending');
    expect(raw.rows.find((row) => row.event === 'cleanup-entry')?.body).toBe('pending');
    expect(raw.rows.find((row) => row.event === 'body-settlement')).toMatchObject({ body: 'fulfilled', sampleLate: true });
  }
  await fs.writeFile(path.join(directory, 'availability.json'), JSON.stringify(availability, null, 2));
}, 70000);
