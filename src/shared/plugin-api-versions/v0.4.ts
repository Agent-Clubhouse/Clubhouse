/**
 * Frozen API snapshot for plugin API v0.4.
 *
 * DO NOT MODIFY these interfaces — they are the compile-time contract for
 * plugins targeting engine.api: 0.4.
 *
 * v0.4 is a superset of v0.2, adding:
 *   - `logging` sub-API (debug/info/warn/error/fatal)
 *   - `files` sub-API (tree/read/write/stat/rename/copy/mkdir/delete/showInFolder)
 *   - Manifest-level: `contributes.help` is mandatory for v0.4+
 */

import type { PluginAPI } from '../plugin-types';
import type { FileNode } from '../types';

// ── v0.4 scoped types ─────────────────────────────────────────────────

export interface LoggingAPI_V0_4 {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
}

export interface FileStatInfo_V0_4 {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: number;
}

export interface FilesAPI_V0_4 {
  readTree(relativePath?: string, options?: { includeHidden?: boolean; depth?: number }): Promise<FileNode[]>;
  readFile(relativePath: string): Promise<string>;
  readBinary(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  stat(relativePath: string): Promise<FileStatInfo_V0_4>;
  rename(oldRelativePath: string, newRelativePath: string): Promise<void>;
  copy(srcRelativePath: string, destRelativePath: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  delete(relativePath: string): Promise<void>;
  showInFolder(relativePath: string): Promise<void>;
}

// ── Composite v0.4 API ────────────────────────────────────────────────

export interface PluginAPI_V0_4 {
  logging: LoggingAPI_V0_4;
  files: FilesAPI_V0_4;
}

// ── Compile-time backward-compat guard ────────────────────────────────
// Fails to compile if the current PluginAPI drops or changes any v0.4 member.
type _V0_4_BackCompat = PluginAPI extends PluginAPI_V0_4 ? true : never;
const _v0_4_check: _V0_4_BackCompat = true;
void _v0_4_check;
