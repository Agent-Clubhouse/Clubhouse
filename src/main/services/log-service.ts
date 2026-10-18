import { app } from 'electron';
import * as path from 'path';
import type { Dirent } from 'fs';
import * as fsp from 'fs/promises';
import { LogEntry, LOG_RETENTION_TIERS, LOG_LEVEL_PRIORITY } from '../../shared/types';
import * as logSettings from './log-settings';
import { bridgeLog, traceFieldsForLog, type LogTelemetry } from '../telemetry/log-bridge';
import { recordBreadcrumb, recordBreadcrumbFrom } from './breadcrumbs';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_ENTRY_THRESHOLD = 50;

let logDir: string;
let sessionBase: string;
let currentChunk = 0;
let currentFilePath: string;
let currentFileSize = 0;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const seenNamespaces = new Set<string>();

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

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(logDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Collect session log files with their stats
  const files: { filePath: string; mtimeMs: number; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const filePath = path.join(logDir, entry.name);
    try {
      const stat = await fsp.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // ignore stat errors
    }
  }

  // Phase 1: age-prune (skip if unlimited — retentionDays === 0)
  if (tier.retentionDays > 0) {
    const cutoff = Date.now() - tier.retentionDays * 24 * 60 * 60 * 1000;
    for (let i = files.length - 1; i >= 0; i--) {
      if (files[i].mtimeMs < cutoff) {
        try { await fsp.unlink(files[i].filePath); } catch { /* ignore */ }
        files.splice(i, 1);
      }
    }
  }

  // Phase 2: size-prune — delete oldest files until under cap (skip if unlimited — maxTotalBytes === 0)
  if (tier.maxTotalBytes > 0) {
    // Sort oldest first
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    while (totalSize > tier.maxTotalBytes && files.length > 0) {
      const oldest = files.shift()!;
      try { await fsp.unlink(oldest.filePath); } catch { /* ignore */ }
      totalSize -= oldest.size;
    }
  }
}

export async function flush(): Promise<void> {
  if (buffer.length === 0) return;
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
 * Feedback breadcrumbs from log entries (#2098), taken whatever the local log
 * settings are: hang and lag lines (`ui:perf`, #2126) as performance
 * breadcrumbs, and any entry that carries a `meta.breadcrumb` (the renderer's
 * view changes and runtime switches). Plugins' namespaces can't add any.
 */
function tapBreadcrumb(entry: LogEntry): void {
  const meta = entry.meta;
  if (entry.ns === 'ui:perf') {
    const kind = meta?.kind;
    if ((kind === 'long_frame' || kind === 'slow_interaction') && typeof meta?.maxMs === 'number') {
      recordBreadcrumb('performance', `ui.${kind}`, meta.maxMs);
    } else if (typeof meta?.durationMs === 'number') {
      // A window that stopped responding, logged once it recovers.
      recordBreadcrumb('performance', 'window.unresponsive', meta.durationMs);
    }
    return;
  }
  if (meta?.breadcrumb && !entry.ns.startsWith('plugin')) recordBreadcrumbFrom(meta.breadcrumb);
}

/**
 * `telemetry` (opt-in, spec §6.6) is bridged before the local logging
 * filters: turning local logging off does not turn telemetry off, and the
 * reverse. Only the declared event and attributes are exported.
 */
export function log(entry: LogEntry, telemetry?: LogTelemetry): void {
  if (telemetry) bridgeLog(entry.level, telemetry);
  tapBreadcrumb(entry);

  const settings = logSettings.getSettings();
  if (!settings.enabled) return;

  seenNamespaces.add(entry.ns);

  // Check namespace filter: if explicitly set to false, skip
  if (settings.namespaces[entry.ns] === false) return;

  // Check minimum log level
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[settings.minLogLevel]) return;

  const line = JSON.stringify(entry);
  buffer.push(line);

  if (buffer.length >= FLUSH_ENTRY_THRESHOLD) {
    flush();
  }
}

export function appLog(
  ns: string,
  level: LogEntry['level'],
  msg: string,
  opts?: { projectId?: string; meta?: Record<string, unknown>; telemetry?: LogTelemetry },
): void {
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

export function getLogPath(): string {
  return logDir;
}

export function getNamespaces(): string[] {
  return [...seenNamespaces].sort();
}

export async function init(): Promise<void> {
  await ensureLogDir();
  sessionBase = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  currentChunk = 0;
  await openSessionFile();
  await cleanup();

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  app.on('before-quit', () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    flush();
  });
}
