// Raw Node behaviour on this OS, with no SDK involved. Synthetic files in a temp dir.
import { open, readFile, rename, writeFile, unlink, mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = await mkdtemp(join(tmpdir(), 'wrf-raw-'));
const code = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code ?? String(e); } };
console.log('node', process.version, process.platform, process.arch, 'libuv', process.versions.uv);
const dest = join(dir, 'binding.json');
await writeFile(dest, 'old');
await writeFile(join(dir, 't1'), 'new');
const held = await open(dest, 'r');
console.log('rename over a file open for read:', await code(() => rename(join(dir, 't1'), dest)));
await held.close();
const tally = {};
let stop = false;
const reader = (async () => { while (!stop) await readFile(dest, 'utf8').catch(() => {}); })();
for (let i = 0; i < 500; i++) {
  const tmp = join(dir, `t-${i}`);
  await writeFile(tmp, String(i));
  const c = await code(() => rename(tmp, dest));
  tally[c] = (tally[c] ?? 0) + 1;
  if (c !== 'ok') await unlink(tmp).catch(() => {});
}
stop = true; await reader;
console.log('500 renames over a file with one readFile loop running:', JSON.stringify(tally));
const sub = join(dir, 'report'), inside = join(sub, 'state.json');
await mkdir(sub); await writeFile(inside, 'x');
const inner = await open(inside, 'r');
console.log('rename a directory with a file open inside:', await code(() => rename(sub, join(dir, 'grave'))));
await inner.close();
const lock = join(dir, 'outbox.lock'), lockTally = {};
for (let i = 0; i < 500; i++) {
  const h = await open(lock, 'wx'); await h.writeFile('{}'); await h.sync(); await h.close();
  const r = readFile(lock, 'utf8').catch(() => {});
  const u = await code(() => unlink(lock));
  const c = await code(async () => { const n = await open(lock, 'wx'); await n.close(); });
  lockTally[`unlink=${u} reopen=${c}`] = (lockTally[`unlink=${u} reopen=${c}`] ?? 0) + 1;
  await r; await unlink(lock).catch(() => {});
}
console.log('500 lock create, unlink with a read in flight, re-create:', JSON.stringify(lockTally));
