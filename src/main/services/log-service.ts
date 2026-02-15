import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { LogEntry, LOG_RETENTION_TIERS, LOG_LEVEL_PRIORITY } from '../../shared/types';
import * as logSettings from './log-settings';

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

function ensureLogDir(): void {
  if (!logDir) {
    logDir = path.join(app.getPath('home'), '.clubhouse', 'logs');
  }
  fs.mkdirSync(logDir, { recursive: true });
}

function buildFilePath(chunk: number): string {
  if (chunk === 0) return path.join(logDir, `session-${sessionBase}.jsonl`);
  return path.join(logDir, `session-${sessionBase}.${chunk}.jsonl`);
}

function openSessionFile(): void {
  currentFilePath = buildFilePath(currentChunk);
  try {
    const stat = fs.statSync(currentFilePath);
    currentFileSize = stat.size;
  } catch {
    currentFileSize = 0;
  }
}

function rotate(): void {
  currentChunk += 1;
  openSessionFile();
}

function cleanup(): void {
  const settings = logSettings.getSettings();
  const tier = LOG_RETENTION_TIERS[settings.retention] ?? LOG_RETENTION_TIERS.medium;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
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
      const stat = fs.statSync(filePath);
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
        try { fs.unlinkSync(files[i].filePath); } catch { /* ignore */ }
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
      try { fs.unlinkSync(oldest.filePath); } catch { /* ignore */ }
      totalSize -= oldest.size;
    }
  }
}

export function flush(): void {
  if (buffer.length === 0) return;
  const data = buffer.join('\n') + '\n';
  buffer = [];
  try {
    fs.appendFileSync(currentFilePath, data, 'utf-8');
    currentFileSize += Buffer.byteLength(data, 'utf-8');
    if (currentFileSize >= MAX_FILE_SIZE) {
      rotate();
    }
  } catch {
    // If we can't write, drop the entries rather than crashing
  }
}

export function log(entry: LogEntry): void {
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
  opts?: { projectId?: string; meta?: Record<string, unknown> },
): void {
  log({
    ts: new Date().toISOString(),
    ns,
    level,
    msg,
    projectId: opts?.projectId,
    meta: opts?.meta,
  });
}

export function getLogPath(): string {
  return logDir;
}

export function getNamespaces(): string[] {
  return [...seenNamespaces].sort();
}

export function init(): void {
  ensureLogDir();
  sessionBase = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  currentChunk = 0;
  openSessionFile();
  cleanup();

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  app.on('before-quit', () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    flush();
  });
}
