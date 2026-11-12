import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ImportError } from './types';

export const CHECKOUT_MAX_ENTRIES = 20_000;
export const CHECKOUT_MAX_BYTES = 64 * 1024 * 1024;
export const CHECKOUT_MAX_DEPTH = 128;
export const CHECKOUT_INSPECTION_MS = 250;

export function protectedRuntimeName(name: string): boolean {
  return ['.clubhouse', '.clubhouse-dev'].includes(name.split(':')[0].replace(/[. ]+$/, '').toLowerCase());
}

/** Bind a clean Git status to the exact working-tree bytes across subsequent awaits. */
export function checkoutFingerprint(destination: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const started = performance.now();
  let entries = 0;
  let bytes = 0;
  const changed = () => new ImportError('checkout_changed', 'Checkout content changed before registration. All files were preserved; inspect and explicitly register this checkout.');
  const limit = () => new ImportError('checkout_inspection_limit', 'Checkout finished, but its working tree exceeds bounded registration inspection (20,000 entries, 64 MiB, depth 128, 250 ms budget). It was preserved; inspect it before explicit local registration.');
  const checkTime = () => { if (performance.now() - started > CHECKOUT_INSPECTION_MS) throw limit(); };
  const signature = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const walk = (relative: string, depth: number) => {
    checkTime();
    if (depth > CHECKOUT_MAX_DEPTH) throw limit();
    const file = path.join(destination, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw changed();
    hash.update(`${relative}\0${signature(stat)}\0`);
    if (stat.isFile()) {
      if (stat.nlink !== 1n) throw changed();
      if (stat.size > BigInt(CHECKOUT_MAX_BYTES - bytes)) throw limit();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        if (signature(fs.fstatSync(fd, { bigint: true })) !== signature(stat)) throw changed();
        let length = 0;
        for (;;) {
          checkTime();
          const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, CHECKOUT_MAX_BYTES - bytes + 1), null);
          if (!read) break;
          bytes += read;
          length += read;
          if (bytes > CHECKOUT_MAX_BYTES) throw limit();
          hash.update(buffer.subarray(0, read));
        }
        if (BigInt(length) !== stat.size || signature(fs.fstatSync(fd, { bigint: true })) !== signature(stat)) throw changed();
      } finally {
        fs.closeSync(fd);
      }
    } else {
      const names: string[] = [];
      const directory = fs.opendirSync(file);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          checkTime();
          if (!relative && entry.name === '.git') continue;
          if (++entries > CHECKOUT_MAX_ENTRIES) throw limit();
          if (!relative && protectedRuntimeName(entry.name)) {
            throw new ImportError('repository_app_state', 'Clubhouse runtime state appeared in the checkout. It was preserved and was not registered; inspect it before reusing this location.');
          }
          names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      for (const name of names.sort()) walk(path.join(relative, name), depth + 1);
      if (signature(fs.lstatSync(file, { bigint: true })) !== signature(stat)) throw changed();
    }
  };
  walk('', 0);
  return hash.digest('hex');
}
