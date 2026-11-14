export const HANDOFF_TRANSFER_DEFAULTS = {
  totalBytes: 1024 ** 3,
  perFileBytes: 256 * 1024 ** 2,
  maxFiles: 10_000,
} as const;
export const HANDOFF_TRANSFER_MAX_BYTES = 16 * 1024 ** 3;
export const HANDOFF_MANIFEST_MAX_BYTES = 2 * 1024 ** 2;
export const HANDOFF_PATH_MAX_CHARS = 1024;
const MAX_PATTERNS = 100;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const hasIgnorable = (value: string) => /\p{Default_Ignorable_Code_Point}/u.test(value);

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export interface HandoffTransferBounds {
  totalBytes: number;
  perFileBytes: number;
  maxFiles: number;
}

export interface HandoffManifestFile {
  path: string;
  size: number;
  sha256: string;
  mode: '100644' | '100755' | '120000';
}

export interface HandoffWorktreeManifest {
  v: 1;
  repo: { remote: string | null; base: string; branch: string };
  include: { tracked_changes: boolean; untracked: boolean; ignored: string[] };
  exclude: string[];
  files: HandoffManifestFile[];
  deletions: string[];
  /** Private Git bundle artifact; never materialized as a worktree path. */
  bundle?: { size: number; sha256: string };
  total_bytes: number;
  manifest_sha256: string;
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid handoff manifest.');
}

/** One portable relative regular-file path; no alternate Windows spellings. */
export function isSafeHandoffPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > HANDOFF_PATH_MAX_CHARS
    || !isWellFormed(value) || hasIgnorable(value) || /[\\:<>"|?*]/.test(value) || hasControl(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && part.toLowerCase() !== '.git' && !/^\.?git~[0-9]+$/i.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part));
}

export function isSafeHandoffBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value !== '@' && value !== 'HEAD'
    && isWellFormed(value) && !hasIgnorable(value) && !value.startsWith('-')
    && !/[\\\s~^:?*]/.test(value) && !hasControl(value) && !value.includes('[') && !value.includes('..') && !value.includes('@{')
    && value.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}

export function isSafeHandoffPattern(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('!')
    || !isWellFormed(value) || hasIgnorable(value) || /[\\:]/.test(value) || hasControl(value)) return false;
  return value.split('/').every((part) => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export function validateHandoffBounds(value: HandoffTransferBounds): HandoffTransferBounds {
  requireValid(object(value) && keys(value, ['totalBytes', 'perFileBytes', 'maxFiles'])
    && integer(value.totalBytes) && value.totalBytes > 0 && value.totalBytes <= HANDOFF_TRANSFER_MAX_BYTES
    && integer(value.perFileBytes) && value.perFileBytes > 0 && value.perFileBytes <= value.totalBytes
    && integer(value.maxFiles) && value.maxFiles > 0 && value.maxFiles <= HANDOFF_TRANSFER_DEFAULTS.maxFiles);
  return { totalBytes: value.totalBytes, perFileBytes: value.perFileBytes, maxFiles: value.maxFiles };
}

function validRemote(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !value || value.length > 2048 || !isWellFormed(value) || /\s/.test(value) || hasControl(value)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/].+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return ['https:', 'ssh:', 'git:'].includes(url.protocol) && !!url.hostname && !url.password && !url.search && !url.hash
      && (url.protocol === 'ssh:' || !url.username);
  } catch {
    // telemetry-exempt: a malformed remote is rejected, never logged or returned
    return false;
  }
}

function patterns(value: unknown): string[] {
  requireValid(Array.isArray(value) && value.length <= MAX_PATTERNS && value.every(isSafeHandoffPattern)
    && new Set(value).size === value.length);
  return [...value].sort(compare);
}

const portableKey = (path: string) => path.normalize('NFC').toLowerCase();

export function parseHandoffManifest(raw: unknown, limits: HandoffTransferBounds = HANDOFF_TRANSFER_DEFAULTS): HandoffWorktreeManifest {
  const bounds = validateHandoffBounds(limits);
  requireValid(object(raw) && keys(raw, ['v', 'repo', 'include', 'exclude', 'files', 'deletions', 'bundle', 'total_bytes', 'manifest_sha256'])
    && raw.v === 1 && object(raw.repo) && keys(raw.repo, ['remote', 'base', 'branch']) && validRemote(raw.repo.remote)
    && typeof raw.repo.base === 'string' && COMMIT.test(raw.repo.base) && isSafeHandoffBranch(raw.repo.branch)
    && object(raw.include) && keys(raw.include, ['tracked_changes', 'untracked', 'ignored'])
    && typeof raw.include.tracked_changes === 'boolean' && typeof raw.include.untracked === 'boolean'
    && Array.isArray(raw.files) && Array.isArray(raw.deletions) && raw.files.length + raw.deletions.length <= bounds.maxFiles
    && integer(raw.total_bytes) && raw.total_bytes <= bounds.totalBytes
    && typeof raw.manifest_sha256 === 'string' && SHA256.test(raw.manifest_sha256));
  let bundle: HandoffWorktreeManifest['bundle'];
  if (raw.bundle !== undefined) {
    requireValid(object(raw.bundle) && keys(raw.bundle, ['size', 'sha256']) && integer(raw.bundle.size) && raw.bundle.size > 0
      && raw.bundle.size <= bounds.perFileBytes && typeof raw.bundle.sha256 === 'string' && SHA256.test(raw.bundle.sha256)
      && raw.files.length + raw.deletions.length + 1 <= bounds.maxFiles);
    bundle = { size: raw.bundle.size, sha256: raw.bundle.sha256 };
  }
  const files: HandoffManifestFile[] = [];
  let total = bundle?.size ?? 0;
  const paths = new Set<string>();
  for (const file of raw.files) {
    requireValid(object(file) && keys(file, ['path', 'size', 'sha256', 'mode']) && isSafeHandoffPath(file.path)
      && integer(file.size) && file.size <= bounds.perFileBytes && typeof file.sha256 === 'string' && SHA256.test(file.sha256)
      && (file.mode === '100644' || file.mode === '100755' || file.mode === '120000' && file.size > 0 && file.size <= 4096));
    const key = portableKey(file.path);
    requireValid(!paths.has(key));
    paths.add(key);
    total += file.size;
    requireValid(Number.isSafeInteger(total) && total <= bounds.totalBytes);
    files.push({ path: file.path, size: file.size, sha256: file.sha256, mode: file.mode });
  }
  for (const key of paths) {
    const parts = key.split('/');
    parts.pop();
    while (parts.length > 0) {
      requireValid(!paths.has(parts.join('/')));
      parts.pop();
    }
  }
  const deletions: string[] = [];
  for (const path of raw.deletions) {
    requireValid(isSafeHandoffPath(path) && !paths.has(portableKey(path)));
    paths.add(portableKey(path));
    deletions.push(path);
  }
  requireValid(total === raw.total_bytes);
  const parsed: HandoffWorktreeManifest = {
    v: 1, repo: { remote: raw.repo.remote, base: raw.repo.base, branch: raw.repo.branch },
    include: { tracked_changes: raw.include.tracked_changes, untracked: raw.include.untracked, ignored: patterns(raw.include.ignored) },
    exclude: patterns(raw.exclude), files: files.sort((a, b) => compare(a.path, b.path)), deletions: deletions.sort(compare),
    ...(bundle && { bundle }), total_bytes: total, manifest_sha256: raw.manifest_sha256,
  };
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > HANDOFF_MANIFEST_MAX_BYTES) throw new Error('Handoff manifest is too large.');
  return parsed;
}

/** Hash this exact UTF-8 string; the digest field itself is deliberately omitted. */
export function canonicalHandoffManifest(manifest: HandoffWorktreeManifest, bounds: HandoffTransferBounds = HANDOFF_TRANSFER_DEFAULTS): string {
  const parsed = parseHandoffManifest(manifest, bounds);
  const { manifest_sha256: _digest, ...body } = parsed;
  const canonical = JSON.stringify(body);
  if (new TextEncoder().encode(canonical).byteLength > HANDOFF_MANIFEST_MAX_BYTES) throw new Error('Handoff manifest is too large.');
  return canonical;
}


export function summarizeHandoffManifest(manifest: HandoffWorktreeManifest) {
  return { fileCount: manifest.files.length + manifest.deletions.length + (manifest.bundle ? 1 : 0), totalBytes: manifest.total_bytes, sha256: manifest.manifest_sha256 };
}
