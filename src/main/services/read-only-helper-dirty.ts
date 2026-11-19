/** Passive helper dirty counts. Never runs status, worktree diff or Git clean/process filters. */
import { createHash } from 'crypto';
import { readOnlyGit, ReadOnlyGitError } from './read-only-repository-changes';
import { readOnlyWorktreeFile } from './read-only-worktree-file';
import { CLUBHOUSE_WRITTEN_FILES, onlyClubhouseChangesFromTexts } from './clubhouse-owned-files';

export class HelperTransformUnavailable extends Error {}
const MAX_PATHS = 2000, MAX_FILE = 1024 * 1024, MAX_CONTENT = 32 * 1024 * 1024;

export async function readOnlyHelperDirty(root: string, head: string | null, authorized: () => boolean): Promise<number> {
  const checked = async <T>(work: Promise<T>) => { const value = await work; if (!authorized()) throw new Error('revoked'); return value; };
  const git = async (args: string[], input?: string) => (await checked(readOnlyGit(root, args, undefined, input))).toString();
  const setting = async (name: string) => {
    try { return (await git(['config', '--bool-or-str', '--get', name])).trim(); }
    catch (error) { if (error instanceof ReadOnlyGitError && error.code === 1) return null; throw error; }
  };
  const format = (await git(['rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(format)) throw new Error('Unsupported object format.');
  const oid = (bytes: Buffer) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const rawIndex = await git(['ls-files', '--stage', '-v', '-z']);
  const index = new Map<string, { mode: string; oid: string; stage: string; ignored: boolean }>();
  for (const item of rawIndex.split('\0').filter(Boolean)) {
    const match = /^([A-Za-z]) (\d+) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(item);
    if (!match) throw new Error('Index unavailable.');
    index.set(match[5], { mode: match[2], oid: match[3], stage: match[4], ignored: match[1] === 'S' || match[1] === match[1].toLowerCase() });
  }
  // --cached compares two stored sides only. No worktree conversion, external
  // diff or textconv can run, including if config/attributes change mid-read.
  const staged = (await git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--name-status', '-z', ...(head ? [head] : []), '--'])).split('\0');
  const dirty = new Map<string, string>();
  for (let i = 0; i < staged.length && staged[i];) {
    const code = staged[i++];
    const from = staged[i++];
    const file = /^[RC]\d+$/.test(code) ? staged[i++] : from;
    if (!/^(?:[ACDMRTUXB]|[RC]\d+)$/.test(code) || !from || !file) throw new Error('Staged evidence unavailable.');
    dirty.set(file, code);
  }
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z'])).split('\0').filter(Boolean);
  const extra: string[] = [];
  for (const file of untracked) {
    if (file.endsWith('/') && CLUBHOUSE_WRITTEN_FILES.some((known) => known.startsWith(file))) {
      extra.push(...(await git(['ls-files', '--others', '--exclude-standard', '-z', '--', file])).split('\0').filter(Boolean));
    } else extra.push(file);
  }
  if (index.size + dirty.size + extra.length > MAX_PATHS) throw new Error('Helper work read limit.');
  const attrs = new Map<string, Record<string, string>>();
  const paths = [...index.keys()];
  if (paths.length) {
    const values = (await git(['check-attr', '-z', '--stdin', 'text', 'eol', 'filter', 'ident', 'working-tree-encoding'], paths.join('\0') + '\0')).split('\0');
    if (values.pop() !== '' || values.length % 3) throw new Error('Attributes unavailable.');
    for (let i = 0; i < values.length; i += 3) attrs.set(values[i], { ...attrs.get(values[i]), [values[i + 1]]: values[i + 2] });
  }
  const autoCrlf = await setting('core.autocrlf');
  if (autoCrlf !== null && !['true', 'false', 'input'].includes(autoCrlf)) throw new Error('Line ending setting unavailable.');
  const fileMode = await setting('core.fileMode');
  if (fileMode !== null && !['true', 'false'].includes(fileMode)) throw new Error('File mode setting unavailable.');
  let budget = MAX_CONTENT;
  const read = async (file: string) => {
    const result = await checked(readOnlyWorktreeFile(root, file, Math.min(MAX_FILE, budget)));
    if (result.state === 'ok') budget -= result.bytes.length;
    else if (result.state !== 'missing') throw new Error('Helper file unavailable.');
    return result;
  };
  for (const [file, entry] of index) {
    if (dirty.has(file) || entry.ignored) continue;
    if (entry.stage !== '0' || !['100644', '100755'].includes(entry.mode)) throw new Error('Helper index entry unavailable.');
    const attr = attrs.get(file);
    if (!attr || ['filter', 'ident', 'working-tree-encoding'].some((key) => attr[key] && !['unspecified', 'unset'].includes(attr[key]))) throw new HelperTransformUnavailable();
    const current = await read(file);
    if (current.state === 'missing') { dirty.set(file, 'D'); continue; }
    if (current.state !== 'ok') throw new Error('Helper file unavailable.');
    const modeChanged = fileMode !== 'false' && entry.mode !== current.mode;
    if (!modeChanged && oid(current.bytes) === entry.oid) continue;
    let bytes = current.bytes;
    if (attr.text !== 'unset' && (attr.text === 'set' || ['lf', 'crlf'].includes(attr.eol)
      || !bytes.includes(0) && (attr.text === 'auto' || autoCrlf === 'true' || autoCrlf === 'input'))) {
      // Preserve arbitrary bytes; decoding binary/non-UTF8 text would change evidence.
      const normalized = Buffer.alloc(bytes.length); let size = 0;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 13 || bytes[i + 1] !== 10) normalized[size++] = bytes[i];
      bytes = normalized.subarray(0, size);
    }
    if (modeChanged || oid(bytes) !== entry.oid) dirty.set(file, 'M');
  }
  const generated = async (file: string) => {
    if (!CLUBHOUSE_WRITTEN_FILES.includes(file)) return false;
    const current = await read(file);
    if (current.state !== 'ok') return false;
    let base: string | null = null;
    let baseMode = '100644';
    if (head) {
      const items = (await git(['ls-tree', '-z', head, '--', file])).split('\0').filter(Boolean);
      if (items.length) {
        const blob = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(items[0]);
        if (items.length !== 1 || !blob) throw new Error('Committed generated file unavailable.');
        baseMode = blob[1];
        const bytes = await checked(readOnlyGit(root, ['cat-file', 'blob', blob[2]], MAX_FILE));
        budget -= bytes.length; base = bytes.toString();
      }
    }
    // A generated-only classification must cover all three sides. The current
    // worktree may have been restored while a user's staged edit remains.
    if (fileMode !== 'false' && current.mode !== baseMode) return false;
    const staged = index.get(file);
    if (staged) {
      if (staged.stage !== '0' || staged.mode !== baseMode) return false;
      const bytes = await checked(readOnlyGit(root, ['cat-file', 'blob', staged.oid], MAX_FILE));
      budget -= bytes.length;
      if (!onlyClubhouseChangesFromTexts(file, bytes.toString(), base)) return false;
    }
    if (budget < 0) throw new Error('Helper comparison read limit.');
    return onlyClubhouseChangesFromTexts(file, current.bytes.toString(), base);
  };
  let count = 0;
  for (const [file, status] of dirty) if (!['A', 'M'].includes(status) || !await generated(file)) count++;
  // A staged deletion and an untracked replacement are two status rows locally.
  for (const file of extra) if (!await generated(file)) count++;
  if (await git(['ls-files', '--stage', '-v', '-z']) !== rawIndex) throw new Error('Index changed during read.');
  return count;
}
