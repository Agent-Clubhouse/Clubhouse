/**
 * Closes the app, and only when the close is slow (more than CLOSE_SLOW_MS)
 * records what a stuck quit looks like: the process tree and the tail of the
 * app's own log files. A close that finishes in time costs nothing extra.
 *
 * Observation only. It never kills anything and never shortens the wait, so a
 * quit that really hangs still fails the test (#3850). Kept free of Playwright
 * imports so it can be unit-tested under vitest.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLOSE_SLOW_MS = 30_000;
const LOG_TAIL_BYTES = 16 * 1024;
const LOG_FILES = 3;
const PROCESS_LIST_TIMEOUT_MS = 15_000;

export interface Closable { close(): Promise<void> }
export interface CloseDiagnosticsOptions {
  /** The app's profile: its `.clubhouse/logs` folder holds the app's own log files. */
  userDataDir: string;
  /** Receives the text of the report; the spec attaches it to the test and prints it. */
  report: (text: string) => void | Promise<void>;
  slowMs?: number;
  /** Seam for tests. */
  collect?: (userDataDir: string) => Promise<string>;
}

const listProcesses = (): Promise<string> => new Promise((resolve) => {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List | Out-String -Width 400']] as const
    : ['ps', ['-eo', 'pid,ppid,etime,stat,args']] as const;
  execFile(file, [...args], { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? `process list failed: ${error.message}` : stdout);
  });
});

function logTails(userDataDir: string): string {
  const folder = path.join(userDataDir, '.clubhouse', 'logs');
  let names: string[];
  try { names = fs.readdirSync(folder); } catch { return `no log folder at ${folder}`; }
  const newest = names
    .map((name) => ({ name, mtime: fs.statSync(path.join(folder, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LOG_FILES);
  return newest.map(({ name }) => {
    const file = path.join(folder, name);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return `--- ${name} (last ${length} of ${size} bytes)\n${buffer.toString('utf8')}`;
    } finally { fs.closeSync(fd); }
  }).join('\n') || `no log files in ${folder}`;
}

async function collectReport(userDataDir: string): Promise<string> {
  const processes = await listProcesses();
  return `=== process list\n${processes}\n=== app log tails\n${logTails(userDataDir)}`;
}

export async function closeWithDiagnostics(app: Closable, options: CloseDiagnosticsOptions): Promise<void> {
  const { slowMs = CLOSE_SLOW_MS, collect = collectReport } = options;
  let timer: NodeJS.Timeout | undefined;
  let reporting: Promise<void> | undefined;
  const slow = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      reporting = (async () => {
        try { await options.report(`app close() still pending after ${slowMs}ms\n${await collect(options.userDataDir)}`); }
        catch { /* observation must never replace the test's own failure */ }
      })();
      resolve();
    }, slowMs);
  });
  const closing = app.close();
  try {
    await Promise.race([closing, slow]);
    await closing;
  } finally {
    if (timer) clearTimeout(timer);
    await reporting;
  }
}
