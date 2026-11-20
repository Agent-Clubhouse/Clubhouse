/** Passive git-object/worktree comparisons. Never calls checkpoint creation, index update or recovery. */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { cleanInheritedEnv, cleanSpawnEnv } from '../util/shell';
import { readOnlyTextDiff } from '../../shared/read-only-diff';
import type { RemoteChangedFile, RemoteChangesQuery, RemoteAgentChanges } from '../../shared/remote-agent-changes';
import { REMOTE_CHANGES_PAGE_SIZE, remoteChangesDiffstat } from '../../shared/remote-agent-changes';
import { readOnlyWorktreeFile } from './read-only-worktree-file';
import { redactSecretValues } from '../telemetry/diag-redaction';
import { redactChangeText } from './read-only-display-text';

const MAX_PATHS = 2000;
const MAX_CONTENT = 1024 * 1024;
const MAX_TOTAL_CONTENT = 32 * 1024 * 1024;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
type TreeEntry = { oid: string; size: number; mode: string };
export interface ReadOnlyComparison { root: string; from: string; to?: string; identity: string }

export class ReadOnlyGitError extends Error {
  constructor(readonly code: number | string | null, readonly stderr: string) { super('Repository evidence could not be read.'); }
}
export function readOnlyGit(cwd: string, args: string[], maxBuffer = MAX_GIT_OUTPUT, input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = cleanInheritedEnv({ ...process.env });
    // A desktop launched from a Git/agent shell must not inherit another repository,
    // index, object database, config injection or executable/helper override.
    for (const key of Object.keys(env)) if (/^(GIT_|DYLD_|LD_)/i.test(key) || /^(SSH_ASKPASS|SSH_AUTH_SOCK|ASKPASS)$/i.test(key)) delete env[key];
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C' });
    const child = execFile('git', ['--no-pager', '--no-lazy-fetch', `--work-tree=${path.resolve(cwd)}`, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'credential.helper=', '-c', 'protocol.allow=never', ...args], {
      cwd, env: cleanSpawnEnv(env),
      timeout: 10_000, maxBuffer, encoding: 'buffer', windowsHide: true,
    }, (error, stdout, stderr) => error ? reject(new ReadOnlyGitError(error.code ?? null, stderr.toString())) : resolve(stdout));
    child.stdin?.on('error', () => reject(new ReadOnlyGitError('STDIN', 'Repository input was not accepted.')));
    child.stdin?.end(input);
  });
}
export async function readOnlyRepositoryRoot(cwd: string): Promise<string | null> {
  // Discover the enclosing .git marker from the selected folder, independently
  // of Git environment/config core.worktree overrides. Linked worktrees use a file.
  let current = await fs.realpath(cwd);
  const device = (await fs.stat(current)).dev;
  for (let depth = 0; depth < 128; depth++) {
    let marker: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try { marker = await fs.lstat(path.join(current, '.git')); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (marker) {
      if (marker.isSymbolicLink() || !marker.isDirectory() && (!marker.isFile() || marker.size > 16 * 1024)) throw new Error('Repository marker is unsafe.');
      const actual = (await readOnlyGit(current, ['rev-parse', '--show-toplevel'])).toString().trim();
      if (await fs.realpath(actual) !== current) throw new Error('Repository context changed.');
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current || (await fs.stat(parent)).dev !== device) return null;
    current = parent;
  }
  throw new Error('Repository discovery exceeds its bound.');
}
async function tree(root: string, ref: string): Promise<Map<string, TreeEntry>> {
  if (!/^[a-f0-9]{40,64}$/.test(ref)) throw new Error('Invalid immutable tree.');
  const raw = await readOnlyGit(root, ['ls-tree', '-rz', '-l', ref]);
  const entries = new Map<string, TreeEntry>();
  for (const item of raw.toString().split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/.exec(item);
    if (!match) throw new Error('Malformed tree evidence.');
    entries.set(match[5], { mode: match[1], oid: match[3], size: match[4] === '-' ? 0 : Number(match[4]) });
  }
  return entries;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const keyFor = (comparison: ReadOnlyComparison, file: string) => hash(Buffer.from(`${comparison.identity}\0${comparison.root}\0${comparison.from}\0${comparison.to ?? 'worktree'}\0${file}`));
const privatePath = (p: string) => p.split('/').some((part) => /^(?:\.git|\.clubhouse|\.claude|\.codex|\.aws|\.ssh|\.azure|\.kube|\.netrc|\.npmrc|\.pypirc|\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part));

async function blobs(root: string, entries: Map<string, TreeEntry>, budget: { bytes: number }): Promise<Map<string, Buffer>> {
  const selected = [...new Map([...entries.values()].filter((v) => v.mode !== '160000' && v.mode !== '120000' && v.size <= MAX_CONTENT).map((e) => [e.oid, e])).values()]
    .filter((entry) => { if (entry.size > budget.bytes) return false; budget.bytes -= entry.size; return true; });
  if (!selected.length) return new Map();
  const result = await readOnlyGit(root, ['cat-file', '--batch'], MAX_TOTAL_CONTENT + MAX_GIT_OUTPUT, selected.map((e) => e.oid).join('\n') + '\n');
  const out = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of selected) {
    const end = result.indexOf(10, offset);
    if (end < 0 || result.subarray(offset, end).toString() !== `${entry.oid} blob ${entry.size}`) throw new Error('Blob evidence changed.');
    offset = end + 1;
    if (result.length < offset + entry.size + 1 || result[offset + entry.size] !== 10) throw new Error('Incomplete blob evidence.');
    out.set(entry.oid, result.subarray(offset, offset + entry.size));
    offset += entry.size + 1;
  }
  return out;
}

export async function readOnlyRepositoryChanges(comparison: ReadOnlyComparison, query: RemoteChangesQuery, authorized: () => boolean = () => true): Promise<Pick<RemoteAgentChanges, 'files' | 'totalFiles' | 'diffstat' | 'offset' | 'nextOffset' | 'uncompared' | 'patch'>> {
  const check = () => { if (!authorized()) throw new Error('read_revoked'); };
  const checked = async <T>(work: Promise<T>): Promise<T> => { const value = await work; check(); return value; };
  check();
  const anchor = await checked(fs.realpath(comparison.root));
  const before = await checked(tree(anchor, comparison.from));
  const after = comparison.to ? await checked(tree(anchor, comparison.to)) : null;
  let fileMode = true;
  if (!after) {
    try { fileMode = (await checked(readOnlyGit(anchor, ['config', '--bool', 'core.fileMode']))).toString().trim() !== 'false'; }
    catch (error) { if (!(error instanceof ReadOnlyGitError) || error.code !== 1) throw error; }
  }
  const worktree = after ? [] : (await checked(readOnlyGit(anchor, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))).toString().split('\0').filter(Boolean);
  const renames = new Map<string, string>();
  const restrictedRenames = new Set<string>();
  if (after && query.scope !== 'branch') {
    const parts = (await checked(readOnlyGit(anchor, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--name-status', '-z', '-M', comparison.from, comparison.to!, '--']))).toString().split('\0');
    for (let i = 0; i < parts.length && parts[i];) {
      const code = parts[i++];
      if (/^[RC]\d+$/.test(code)) {
        const old = parts[i++], next = parts[i++];
        if (privatePath(old) || privatePath(next)) { restrictedRenames.add(old); restrictedRenames.add(next); }
        else if (code.startsWith('R') && before.has(old) && after.has(next)) renames.set(next, old);
      }
      else i++;
    }
  }
  const renamedFrom = new Set(renames.values());
  const all = [...new Set([...before.keys(), ...(after?.keys() ?? worktree)])].filter((p) => !renamedFrom.has(p)).sort();
  const eligible = all.filter((p) => !privatePath(p) && !restrictedRenames.has(p));
  const paths = query.fileKey ? eligible.filter((file) => keyFor(comparison, file) === query.fileKey) : eligible.slice(0, MAX_PATHS);
  const attributes = new Map<string, Record<string, string>>();
  let autoCrlf = false;
  if (!after && paths.length) {
    try {
      const value = (await checked(readOnlyGit(anchor, ['config', '--bool-or-str', '--get', 'core.autocrlf']))).toString().trim().toLowerCase();
      if (!['true', 'false', 'input'].includes(value)) throw new Error('Invalid Git line-ending setting.');
      autoCrlf = value !== 'false';
    }
    catch (error) { if (!(error instanceof ReadOnlyGitError) || error.code !== 1) throw error; }
    const values = (await checked(readOnlyGit(anchor, ['check-attr', '-z', '--stdin', 'text', 'eol', 'filter'], MAX_GIT_OUTPUT, paths.join('\0') + '\0'))).toString().split('\0');
    for (let i = 0; i + 2 < values.length; i += 3) attributes.set(values[i], { ...attributes.get(values[i]), [values[i + 1]]: values[i + 2] });
  }
  const wanted = (entries: Map<string, TreeEntry>) => new Map(paths.filter((p) => !privatePath(p)).map((p) => [p, entries.get(p)]).filter((pair): pair is [string, TreeEntry] => !!pair[1]));
  const budget = { bytes: MAX_TOTAL_CONTENT };
  const beforeWanted = wanted(before);
  for (const p of paths) { const old = renames.get(p); if (old) beforeWanted.set(old, before.get(old)!); }
  const beforeBlobs = await checked(blobs(anchor, beforeWanted, budget));
  const afterBlobs = after ? await checked(blobs(anchor, wanted(after), budget)) : new Map<string, Buffer>();
  const files: RemoteChangedFile[] = [];
  const diffBudget = { remaining: 4_000_000 };
  let patch: RemoteAgentChanges['patch'];
  for (const p of paths) {
    check();
    const oldPath = renames.get(p);
    const left = before.get(oldPath ?? p), right = after?.get(p);
    if (!oldPath && after && left?.oid === right?.oid && left?.mode === right?.mode) continue;
    const fileKey = keyFor(comparison, p);
    const current = after ? null : privatePath(p) ? { state: 'unsafe' as const } : budget.bytes > 0 ? await checked(readOnlyWorktreeFile(anchor, p, Math.min(MAX_CONTENT, budget.bytes))) : { state: 'budget' as const };
    if (current?.state === 'ok') budget.bytes -= current.bytes.length;
    const oldBytes = left ? beforeBlobs.get(left.oid) : Buffer.alloc(0);
    let newBytes = after ? right ? afterBlobs.get(right.oid) : Buffer.alloc(0) : current?.state === 'ok' ? current.bytes : current?.state === 'missing' ? Buffer.alloc(0) : undefined;
    const attrs = attributes.get(p);
    const filtered = !!attrs?.filter && !['unspecified', 'unset'].includes(attrs.filter);
    let evidence: RemoteChangedFile['evidence'] = 'text';
    if (privatePath(p) || left?.mode === '120000' || right?.mode === '120000' || current?.state === 'unsafe') evidence = 'unsafe';
    else if (left?.mode === '160000' || right?.mode === '160000') evidence = 'submodule';
    else if ((left?.size ?? 0) > MAX_CONTENT || (right?.size ?? 0) > MAX_CONTENT || current?.state === 'too-large') evidence = 'too-large';
    else if (current && current.state !== 'ok' && current.state !== 'missing') evidence = current.state;
    else if (!oldBytes || !newBytes) evidence = 'budget';
    else if (oldBytes.includes(0) || newBytes.includes(0)) evidence = 'binary';
    else {
      try { new TextDecoder('utf-8', { fatal: true }).decode(oldBytes); new TextDecoder('utf-8', { fatal: true }).decode(newBytes); }
      catch { evidence = 'binary'; }
    }
    if (filtered) evidence = 'filtered';
    if (evidence === 'text' && !after && newBytes && attrs?.text !== 'unset'
      && (autoCrlf || attrs?.text === 'set' || attrs?.text === 'auto' || ['lf', 'crlf'].includes(attrs?.eol ?? ''))) newBytes = Buffer.from(newBytes.toString('utf8').replace(/\r\n/g, '\n'));
    const nextMode = after ? right?.mode : current?.state === 'ok' ? current.mode : undefined;
    const modeChanged = !!left && !!nextMode && (after || fileMode) && left.mode !== nextMode;
    if (!oldPath && !filtered && oldBytes && newBytes && oldBytes.equals(newBytes) && !modeChanged) continue;
    const diff = evidence === 'text' && oldBytes && newBytes ? readOnlyTextDiff(oldBytes.toString('utf8'), newBytes.toString('utf8'), p, 2_000_000, 128 * 1024, diffBudget) : null;
    if (evidence === 'text' && !diff) evidence = 'too-large';
    const label = redactSecretValues(p).replace(/[\x00-\x1f\x7f]/g, ' ');
    files.push({ path: label.length > 2048 ? label.slice(0, 2020) + '… [path truncated]' : label, ...(oldPath && { oldPath: redactSecretValues(oldPath).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2048) }), fileKey, status: filtered || !oldBytes || !newBytes ? 'unknown' : oldPath ? 'renamed' : !left ? 'added' : (after ? !right : current?.state === 'missing') ? 'deleted' : 'modified', additions: diff?.additions ?? 0, deletions: diff?.deletions ?? 0, binary: evidence === 'binary', countsKnown: !!diff, evidence });
    if (query.fileKey) {
      const beforeText = oldBytes?.toString('utf8') ?? '', afterText = newBytes?.toString('utf8') ?? '';
      const safeBefore = redactChangeText(beforeText), safeAfter = redactChangeText(afterText);
      if (safeBefore === null || safeAfter === null) { patch = { fileKey, state: 'unsafe', redacted: true }; continue; }
      const redacted = safeBefore !== beforeText || safeAfter !== afterText;
      // Redact WHOLE files first: a hunk may begin in the middle of a private key or credential.
      const safeDiff = diff && redacted ? readOnlyTextDiff(safeBefore, safeAfter, p, 2_000_000, 128 * 1024, diffBudget) : diff;
      const text = safeDiff ? redactSecretValues((oldPath ? `rename from ${oldPath}\nrename to ${p}\n` : '') + (modeChanged ? `old mode ${left!.mode}\nnew mode ${nextMode}\n` : '') + safeDiff.patch) : undefined;
      patch = diff && !safeDiff || text && Buffer.byteLength(text) > 128 * 1024 ? { fileKey, state: 'too-large' }
        : redacted && text === '' && diff?.patch ? { fileKey, state: 'unsafe', redacted: true }
          : { fileKey, state: evidence, ...(text !== undefined && { text }), ...(redacted && { redacted: true }) };
    }
  }
  const offset = query.offset ?? 0;
  check();
  if (query.fileKey && !patch) patch = { fileKey: query.fileKey, state: paths.length ? 'unchanged' : 'stale' };
  return { files: query.fileKey ? [] : files.slice(offset, offset + REMOTE_CHANGES_PAGE_SIZE), totalFiles: files.length, offset,
    ...(!query.fileKey && { diffstat: remoteChangesDiffstat(files) }),
    nextOffset: !query.fileKey && offset + REMOTE_CHANGES_PAGE_SIZE < files.length ? offset + REMOTE_CHANGES_PAGE_SIZE : null,
    uncompared: query.fileKey ? 0 : Math.max(0, all.length - paths.length), ...(patch && { patch }) };
}
