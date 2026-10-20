import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { LogEntry, LOG_RETENTION_TIERS, LOG_LEVEL_PRIORITY } from '../../shared/types';
import * as logSettings from './log-settings';
import { bridgeLog, traceFieldsForLog, type LogTelemetry } from '../telemetry/log-bridge';
import { pruneLogDir } from '../telemetry/local-retention';
import { diag, getDiagNamespaces, getDiagSink, isDiagActive, type DiagEntry } from '../telemetry/diag';
import { listLogNamespaces } from '../../shared/log-namespaces';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_ENTRY_THRESHOLD = 50;
/** Lines held in memory before the log file or the recorder is ready; the oldest go past this. */
const MAX_EARLY_ENTRIES = 500;
/** Startup appLog lines held for diag; well under the recorder's queue (500), so the drain can't overflow it. */
const MAX_EARLY_DIAG = 200;

let logDir: string;
let sessionBase: string;
let currentChunk = 0;
let currentFilePath: string;
let currentFileSize = 0;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const seenNamespaces = new Set<string>();
/**
 * appLog lines from before the local recorder started (#2301), written to
 * diag once it has. `null` once startup is over: from then on a line with no
 * recorder (logging off) is dropped, as diag does.
 */
let earlyDiag: DiagEntry[] | null = [];
let earlyDiagDropped = 0;

async function ensureLogDir(): Promise<void> {
  if (!logDir) {
    logDir = path.join(app.getPath('home'), '.clubhouse', 'logs');
  }
  await fsp.mkdir(logDir, { recursive: true });
}

function buildFilePath(chunk: number): string {
  if (chunk === 0) return path.join(logDir, `session-${sessionBase}.jsonl`);
  return path.join(logDir, `session-${sessionBase}.${chunk}.jsonl`);
}

async function openSessionFile(): Promise<void> {
  currentFilePath = buildFilePath(currentChunk);
  try {
    const stat = await fsp.stat(currentFilePath);
    currentFileSize = stat.size;
  } catch {
    currentFileSize = 0;
  }
}

async function rotate(): Promise<void> {
  currentChunk += 1;
  await openSessionFile();
}

async function cleanup(): Promise<void> {
  const settings = logSettings.getSettings();
  const tier = LOG_RETENTION_TIERS[settings.retention] ?? LOG_RETENTION_TIERS.medium;
  // Shared with local telemetry recordings; the recorder also runs it while recording (#2298).
  await pruneLogDir(logDir, tier, { protect: currentFilePath ? [currentFilePath] : [] });
}

/** Write the held startup lines to diag, if the recorder has started. */
function drainEarlyDiag(): void {
  if (!earlyDiag || !isDiagActive()) return;
  const lines = earlyDiag;
  earlyDiag = null;
  if (earlyDiagDropped > 0) {
    diag('core:startup', 'warn', 'Startup log lines dropped before the recorder started', { dropped: earlyDiagDropped });
  }
  earlyDiagDropped = 0;
  for (const e of lines) diag(e.ns, e.level, e.msg, e.meta);
}

/** Writes both the session log and the diag lines (the local recorder). */
export async function flush(): Promise<void> {
  drainEarlyDiag();
  await Promise.all([flushSessionLog(), getDiagSink()?.flush().catch(() => {})]);
}

async function flushSessionLog(): Promise<void> {
  // Before init() there is no file yet: keep the lines for init() to write (#2301).
  if (buffer.length === 0 || !currentFilePath) return;
  const data = buffer.join('\n') + '\n';
  buffer = [];
  try {
    await fsp.appendFile(currentFilePath, data, 'utf-8');
    currentFileSize += Buffer.byteLength(data, 'utf-8');
    if (currentFileSize >= MAX_FILE_SIZE) {
      await rotate();
    }
  } catch (err) {
    // If we can't write, drop the entries rather than crashing.
    // Log to stderr as a last resort since our own logging path failed.
    console.error('[log-service] Failed to write log entries:', err instanceof Error ? err.message : err);
  }
}

/**
 * Write the buffer now, synchronously: an OS shutdown, restart or logoff may
 * end the process before an async write lands (#2335). Skips rotation; the
 * next async flush rotates if the file is over the limit.
 */
export function flushSync(): void {
  try {
    getDiagSink()?.flushSync?.();
  } catch {
    // telemetry-exempt: the recorder's own write failed; it counts its drops
  }
  if (buffer.length === 0 || !currentFilePath) return;
  const data = buffer.join('\n') + '\n';
  buffer = [];
  try {
    fs.appendFileSync(currentFilePath, data, 'utf-8');
    currentFileSize += Buffer.byteLength(data, 'utf-8');
  } catch (err) {
    // telemetry-exempt: logging's own write failed; drop the entries, stderr is the last resort
    console.error('[log-service] Failed to write log entries:', err instanceof Error ? err.message : err);
  }
}

/**
 * `telemetry` (spec §6.6) is bridged before the namespace and level
 * filters, which apply only to log lines. Whether the bridged event is
 * recorded or exported follows the telemetry recording settings. Only the
 * declared event and attributes are kept.
 */
export function log(entry: LogEntry, telemetry?: LogTelemetry): void {
  if (telemetry) bridgeLog(entry.level, telemetry);

  const settings = logSettings.getSettings();
  if (!settings.enabled) return;

  seenNamespaces.add(entry.ns);

  // Check namespace filter: if explicitly set to false, skip
  if (settings.namespaces[entry.ns] === false) return;

  // Check minimum log level
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[settings.minLogLevel]) return;

  const line = JSON.stringify(entry);
  buffer.push(line);

  if (!currentFilePath) {
    if (buffer.length > MAX_EARLY_ENTRIES) buffer.shift();
  } else if (buffer.length >= FLUSH_ENTRY_THRESHOLD) {
    void flushSessionLog();
  }
}

/**
 * The diag half of appLog (#2301): `projectId` goes in `meta`. Before the
 * recorder starts the line is held, raw and in memory only; diag gates and
 * redacts it when it is written.
 */
function appDiag(ns: string, level: LogEntry['level'], msg: string, opts?: { projectId?: string; meta?: Record<string, unknown> }): void {
  const meta = opts?.projectId && opts.meta?.projectId === undefined ? { projectId: opts.projectId, ...opts.meta } : opts?.meta;
  drainEarlyDiag();
  if (earlyDiag && !isDiagActive()) {
    // A copy, so a caller changing its object later doesn't change the line.
    earlyDiag.push({ ns, level, msg, meta: meta && { ...meta } });
    if (earlyDiag.length > MAX_EARLY_DIAG) {
      earlyDiag.shift();
      earlyDiagDropped++;
    }
    return;
  }
  diag(ns, level, msg, meta);
}

export function appLog(
  ns: string,
  level: LogEntry['level'],
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown>; telemetry?: LogTelemetry },
): void {
  // The local-only diag tier (spec §6.12). The session log below is written
  // too until it is deleted (#2313).
  try {
    appDiag(ns, level, msg, opts);
  } catch {
    // telemetry-exempt: a logger must never throw, and reporting would recurse
  }
  log({
    ts: new Date().toISOString(),
    ns,
    level,
    msg,
    projectId: opts?.projectId,
    meta: opts?.meta,
    ...traceFieldsForLog(),
  }, opts?.telemetry);
}

/** The session log file being written now, if logging started. */
export function getCurrentLogFile(): string | undefined {
  return currentFilePath;
}

export function getLogPath(): string {
  return logDir;
}

/** Known namespaces plus those seen this run, so Settings can list them at startup (#2312). */
export function getNamespaces(): string[] {
  // Namespaces written through the diag tier (#2299) are listed too.
  return listLogNamespaces(new Set([...seenNamespaces, ...getDiagNamespaces()]));
}

export async function init(): Promise<void> {
  await ensureLogDir();
  sessionBase = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  currentChunk = 0;
  await openSessionFile();
  await cleanup();

  // Startup is over: the recorder has started if logging is on. Lines held
  // until now are written, or dropped when it never will start.
  drainEarlyDiag();
  earlyDiag = null;
  earlyDiagDropped = 0;
  void flushSessionLog();

  flushTimer = setInterval(flushSessionLog, FLUSH_INTERVAL_MS);

  app.on('before-quit', () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    flush();
  });
}

/** Test-only: back to startup, with nothing held. */
export function _resetEarlyLogForTests(): void {
  buffer = [];
  earlyDiag = [];
  earlyDiagDropped = 0;
}
