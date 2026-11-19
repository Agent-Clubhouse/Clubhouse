/** Display-only native lookup: bounded iteration, no unbounded directory arrays. */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { TranscriptReadStats } from './types';

export const PASSIVE_SESSION_LOOKUP_LIMITS = { entries: 512, directories: 32, probes: 64, depth: 4 } as const;

export class PassiveSessionLookup {
  private entries = 0;
  private directories = 0;
  private probes = 0;
  private incomplete = false;
  constructor(private readonly stats?: TranscriptReadStats) { this.record(); }
  private record() {
    if (this.stats) Object.assign(this.stats, { lookupEntries: this.entries, lookupDirectories: this.directories, lookupProbes: this.probes });
  }
  private limited() { this.incomplete = true; if (this.stats) this.stats.lookupIncomplete = true; return false; }
  /** Reserve fixed candidate probes too, before performing any of them. */
  reserveProbes(count: number): boolean {
    if (this.probes + count > PASSIVE_SESSION_LOOKUP_LIMITS.probes) return this.limited();
    this.probes += count; this.record(); return true;
  }
  async find(directory: string, matches: (name: string) => boolean, recursive = false, depth = 0): Promise<string | null> {
    if (this.directories >= PASSIVE_SESSION_LOOKUP_LIMITS.directories || !this.reserveProbes(1)) { this.limited(); return null; }
    this.directories++; this.record();
    let dir: Awaited<ReturnType<typeof fsp.opendir>>;
    try { dir = await fsp.opendir(directory, { bufferSize: 1 }); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) this.limited();
      return null;
    }
    try {
      while (true) {
        // Stop before admitting another read. Even nonmatching files and empty
        // directories consume the same invocation-wide budget across recursion.
        if (this.entries >= PASSIVE_SESSION_LOOKUP_LIMITS.entries) { this.limited(); return null; }
        const entry = await dir.read();
        if (!entry) return null;
        this.entries++; this.record();
        const file = path.join(directory, entry.name);
        if (entry.isFile() && matches(entry.name)) return file;
        if (recursive && entry.isDirectory()) {
          if (depth >= PASSIVE_SESSION_LOOKUP_LIMITS.depth) { this.limited(); return null; }
          const selected = await this.find(file, matches, true, depth + 1);
          if (selected) return selected;
          if (this.incomplete) return null;
        }
      }
    } catch { this.limited(); return null; }
    finally { await dir.close(); }
  }
}
