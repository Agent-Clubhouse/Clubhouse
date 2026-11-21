// Actual synthetic fixture-process cuts and in-memory reuse-barrier mutation.
// No app, driver, runtime, provider or live data imports.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const ts = require('typescript');
const directory = process.argv[2];
const mode = process.argv[3];
if (!['prepare-unflushed', 'temp-opened', 'fifo-swap', 'reuse-guarded', 'skip-reuse-dirty'].includes(mode)) throw new Error('Unknown index fixture mode');
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith(`${path.sep}pages.ts`) && mode === 'skip-reuse-dirty') {
    const target = 'this.markPageDirectories(location); // Reused page barrier: must survive process reopen.';
    if (source.split(target).length !== 2) throw new Error('Mutation target missing or ambiguous');
    source = source.replace(target, '/* removed only reused-page directory tracking */');
  }
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
};
const { NoticePageIndex } = require(path.resolve('src/main/services/group-project-notice-ledger/pages.ts'));
const prepare = async (options) => {
  const index = await NoticePageIndex.open(directory, options);
  const root = await index.set(undefined, 'stable-id', { state: 'uncertain' });
  return { index, root };
};
(async () => {
  if (mode === 'prepare-unflushed') {
    const { root } = await prepare();
    console.log(JSON.stringify({ root, skippedFlush: true }));
    process.exit(77); // actual fixture exit after rename, before any directory flush
  }
  if (mode === 'temp-opened') {
    await prepare({ testFailure: (point, location) => {
      if (point === 'pageTempOpened') { console.log(JSON.stringify({ point, location })); process.exit(77); }
    } });
    throw new Error('Temp cut was not reached');
  }
  if (mode === 'fifo-swap') {
    const { index, root } = await prepare(); await index.flush();
    const timer = setTimeout(() => { console.log('FAILED: swapped FIFO open blocked'); process.exit(78); }, 3000);
    let swapped = false;
    const reader = await NoticePageIndex.open(directory, { testFailure: (point, location) => {
      if (point === 'beforePageOpen' && !swapped) {
        fs.renameSync(location, location + '.saved');
        execFileSync('mkfifo', [location]); swapped = true;
      }
    } });
    let refused = false;
    try { await reader.get(root, 'stable-id'); }
    catch (error) { refused = true; console.log(JSON.stringify({ refused: true, code: error.code ?? null, message: error.message })); }
    clearTimeout(timer);
    if (!swapped || !refused) throw new Error('FIFO replacement was not refused');
    console.log('PASS: swapped FIFO refused without blocking');
    return;
  }
  const initial = spawnSync(process.execPath, [__filename, directory, 'prepare-unflushed'], { encoding: 'utf8', cwd: process.cwd() });
  console.log(JSON.stringify({ preparationExit: initial.status, preparationSignal: initial.signal, stdout: initial.stdout, stderr: initial.stderr }));
  if (initial.error || initial.signal || initial.status !== 77) throw new Error('Unflushed preparation did not reach its cut');
  const events = [];
  const { index, root } = await prepare({ testFailure: (point, location) => { events.push({ point, location }); } });
  const pendingBeforeFlush = index.cacheStats.pendingDirectoryCount;
  await index.flush();
  const prefix = path.join(directory, root.digest.slice(0, 2));
  const syncPosition = events.findIndex((event) => event.point === 'reusedPageSynced');
  const prefixPosition = events.findIndex((event) => event.point === 'beforeDirectoryFlush' && event.location === prefix);
  console.log(JSON.stringify({ mode, pendingBeforeFlush, syncPosition, prefixPosition, pendingAfterFlush: index.cacheStats.pendingDirectoryCount }));
  if (pendingBeforeFlush !== 3 || syncPosition < 0 || prefixPosition <= syncPosition || index.cacheStats.pendingDirectoryCount !== 0) {
    console.log('SAFETY ASSERTION FAILED: reused orphan prefix barrier missing'); process.exitCode = 2;
  } else console.log('PASS: reused orphan earned file and prefix barriers');
})().catch((error) => { console.error(error); process.exitCode = 1; });
