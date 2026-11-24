/**
 * Antigravity managed instructions (#3792). Antigravity reads the worktree's
 * `AGENTS.md`, which may hold the project's own text, so Clubhouse writes only
 * a marked block in it and keeps every byte outside the block as it was.
 *
 * Antigravity documents a 24,000-byte per-file limit and doesn't say what
 * happens past it, so a file that would be larger is refused with its size
 * and the fix: nothing is written and the start doesn't go ahead. Text is
 * never cut to fit. The 20,000-token aggregate budget also counts the
 * person's own global rules, which Clubhouse can't see, so a delivery is
 * recorded as within the per-file limit with the aggregate unverified.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES, ANTIGRAVITY_PATHS, ANTIGRAVITY_PROVIDER_ID } from '../../../shared/providers/antigravity';
import { appLog } from '../log-service';
import { isManagedStartRefused, ManagedStartRefused } from './start-refused';

export const ANTIGRAVITY_BLOCK_BEGIN = `<!-- BEGIN clubhouse-managed ${ANTIGRAVITY_PROVIDER_ID}: Clubhouse rewrites this block at every start. Text outside it is kept. -->`;
export const ANTIGRAVITY_BLOCK_END = `<!-- END clubhouse-managed ${ANTIGRAVITY_PROVIDER_ID} -->`;

/** What a delivery records about the instructions file's size. */
export interface AntigravityInstructionsReceipt {
  file: string;
  bytes: number;
  maxBytes: number;
  status: 'within_per_file_limit_aggregate_unverified';
}

const BEGIN = Buffer.from(ANTIGRAVITY_BLOCK_BEGIN, 'utf-8');
const END = Buffer.from(ANTIGRAVITY_BLOCK_END, 'utf-8');

function instructionsPath(worktree: string): string {
  return path.join(worktree, ANTIGRAVITY_PATHS.instructions);
}

/** What every Clubhouse marker line starts with, so an edited or cut-short one is noticed rather than read as text. */
const BEGIN_FAMILY = Buffer.from('<!-- BEGIN clubhouse-managed', 'utf-8');
const END_FAMILY = Buffer.from('<!-- END clubhouse-managed', 'utf-8');

const markersRefused = () => new ManagedStartRefused('antigravity_instructions_markers',
  `${ANTIGRAVITY_PATHS.instructions} has Clubhouse's block markers more than once, out of order or edited, so Clubhouse can't tell its text from yours. Nothing was written. Leave one BEGIN and one END clubhouse-managed line exactly as Clubhouse wrote them, or remove both.`);

/**
 * Every line that starts like a marker of `family`. Each must be exactly
 * `marker` followed by LF, CRLF or the end of the file; anything else on the
 * line is refused, never guessed at.
 */
function markerLines(hay: Buffer, family: Buffer, marker: Buffer): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(family); i !== -1; i = hay.indexOf(family, i + 1)) {
    if (i !== 0 && hay[i - 1] !== 0x0a) continue;
    const stop = i + marker.length;
    const exact = hay.subarray(i, stop).equals(marker)
      && (stop === hay.length || hay[stop] === 0x0a || (hay[stop] === 0x0d && hay[stop + 1] === 0x0a));
    if (!exact) throw markersRefused();
    out.push(i);
  }
  return out;
}

interface Parsed {
  /** Bytes before the block, or the whole file when there is none. */
  before: Buffer;
  after: Buffer;
  hasBlock: boolean;
}

/** Split the file around Clubhouse's block. Throws when the markers can't be read unambiguously. */
export function parseAntigravityInstructions(file: Buffer): Parsed {
  const begins = markerLines(file, BEGIN_FAMILY, BEGIN);
  const ends = markerLines(file, END_FAMILY, END);
  if (begins.length === 0 && ends.length === 0) return { before: file, after: Buffer.alloc(0), hasBlock: false };
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) throw markersRefused();
  let stop = ends[0] + END.length;
  if (file[stop] === 0x0d && file[stop + 1] === 0x0a) stop += 2;
  else if (file[stop] === 0x0a) stop += 1;
  return { before: file.subarray(0, begins[0]), after: file.subarray(stop), hasBlock: true };
}

/** The block for `instructions`; none for empty instructions. */
function blockFor(instructions: string): Buffer {
  if (!instructions) return Buffer.alloc(0);
  const body = instructions.endsWith('\n') ? instructions : `${instructions}\n`;
  return Buffer.concat([BEGIN, Buffer.from('\n'), Buffer.from(body, 'utf-8'), END, Buffer.from('\n')]);
}

/** The file as it is, refusing a link or anything other than a plain file: Clubhouse writes only inside the worktree. */
async function readOwnFile(file: string): Promise<{ bytes: Buffer; mode: number } | null> {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new ManagedStartRefused('antigravity_instructions_unsafe',
      `${ANTIGRAVITY_PATHS.instructions} in the agent's folder is a link or not a plain file, so Clubhouse won't write through it. Nothing was written. Replace it with a plain file.`);
  }
  return { bytes: await fsp.readFile(file), mode: st.mode & 0o777 };
}

/** Clubhouse's own writes to one file, one at a time. */
const locks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const run = (locks.get(key) ?? Promise.resolve()).catch((): undefined => undefined).then(fn);
  const tail = run.catch((): undefined => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

function changedRefused(): ManagedStartRefused {
  return new ManagedStartRefused('antigravity_instructions_changed',
    `${ANTIGRAVITY_PATHS.instructions} changed while Clubhouse was writing its block, so Clubhouse left it as it is. Start the agent again.`);
}

async function sameAs(file: string, expected: Buffer | null): Promise<boolean> {
  const now = await readOwnFile(file);
  return expected === null ? now === null : !!now && now.bytes.equals(expected);
}

/**
 * Replace `file` with `next` (or remove it, for null) only while it is still
 * exactly `expected` (null: not there), checked again just before the
 * rename, so an edit made since it was read is never written over. A failed
 * write never leaves half a file. Another program writing in the moment
 * between the last check and the rename can still be lost: the file system
 * has no compare-and-swap.
 */
async function replaceIfUnchanged(file: string, expected: Buffer | null, next: Buffer | null, mode: number | undefined): Promise<void> {
  await withFileLock(file, async () => {
    if (!(await sameAs(file, expected))) throw changedRefused();
    if (next === null) {
      await fsp.rm(file, { force: true });
      return;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.clubhouse-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    try {
      await fsp.writeFile(tmp, next, { flag: 'wx', ...(mode !== undefined && { mode }) });
      if (mode !== undefined && process.platform !== 'win32') await fsp.chmod(tmp, mode);
      if (!(await sameAs(file, expected))) throw changedRefused();
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  });
}

function formatBytes(n: number): string {
  return n.toLocaleString('en-US');
}

export interface AntigravityInstructionsPlan {
  file: string;
  /** The whole file to write, or null when it already is exactly this. */
  write: Buffer | null;
  /** The file as the plan read it (null: not there); the write happens only while it still is. */
  expected: Buffer | null;
  mode?: number;
  receipt: AntigravityInstructionsReceipt;
}

/**
 * Work out the new `AGENTS.md` without writing it: the person's text kept byte
 * for byte, with Clubhouse's block in place of the old one (or first, when
 * there was none). Throws ManagedStartRefused when the file would pass the
 * per-file limit, its markers are ambiguous, or it's a link.
 */
export async function planAntigravityInstructions(worktree: string, instructions: string): Promise<AntigravityInstructionsPlan> {
  const file = instructionsPath(worktree);
  if (instructions.includes(ANTIGRAVITY_BLOCK_BEGIN) || instructions.includes(ANTIGRAVITY_BLOCK_END)) {
    throw new ManagedStartRefused('antigravity_instructions_markers',
      `The agent's instructions contain Clubhouse's ${ANTIGRAVITY_PATHS.instructions} block markers. Nothing was written. Remove the clubhouse-managed BEGIN and END lines from its instruction blocks.`);
  }
  const existing = await readOwnFile(file);
  // Everything outside a block is the person's, even text that matches the instructions (an earlier
  // Codex start writes AGENTS.md whole, but equal text isn't proof Clubhouse wrote it), so it is kept.
  const parsed: Parsed = existing ? parseAntigravityInstructions(existing.bytes) : { before: Buffer.alloc(0), after: Buffer.alloc(0), hasBlock: false };
  const block = blockFor(instructions);
  const next = Buffer.concat(parsed.hasBlock ? [parsed.before, block, parsed.after] : [block, parsed.before]);
  if (next.length > ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES) {
    const yours = parsed.before.length + parsed.after.length;
    throw new ManagedStartRefused('antigravity_instructions_too_large',
      `${ANTIGRAVITY_PATHS.instructions} would be ${formatBytes(next.length)} bytes, over Antigravity's ${formatBytes(ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES)}-byte per-file limit `
      + `(the agent's instructions: ${formatBytes(block.length)} bytes; text outside Clubhouse's block: ${formatBytes(yours)} bytes). `
      + 'Nothing was written and the agent did not start. Shorten the agent\'s instruction blocks in its builder, or move some of the text in AGENTS.md elsewhere. Clubhouse never cuts text to fit.');
  }
  const receipt: AntigravityInstructionsReceipt = {
    file: ANTIGRAVITY_PATHS.instructions, bytes: next.length, maxBytes: ANTIGRAVITY_INSTRUCTIONS_MAX_BYTES, status: 'within_per_file_limit_aggregate_unverified',
  };
  const unchanged = existing ? existing.bytes.equals(next) : next.length === 0;
  return { file, write: unchanged ? null : next, expected: existing?.bytes ?? null, ...(existing && { mode: existing.mode }), receipt };
}

/** Write a plan from planAntigravityInstructions. A plan with nothing to change writes nothing. */
export async function commitAntigravityInstructions(plan: AntigravityInstructionsPlan): Promise<void> {
  if (!plan.write) {
    // Nothing to write, but the start still goes ahead on the file as planned.
    if (!(await sameAs(plan.file, plan.expected))) throw changedRefused();
    return;
  }
  await replaceIfUnchanged(plan.file, plan.expected, plan.write, plan.mode);
}

/**
 * Take Clubhouse's block out of `AGENTS.md`, for a start on another CLI.
 * Everything else stays byte for byte. When nothing else is left, the file
 * goes unless git tracks it (or can't say). A link, a non-file or unreadable
 * markers are left alone and logged.
 */
export async function removeAntigravityInstructionsBlock(worktree: string, isTracked: (rel: string) => Promise<boolean | null>): Promise<void> {
  const file = instructionsPath(worktree);
  let existing;
  let parsed: Parsed;
  try {
    existing = await readOwnFile(file);
    if (!existing) return;
    parsed = parseAntigravityInstructions(existing.bytes);
  } catch (err) {
    if (!isManagedStartRefused(err)) throw err;
    // A link or non-file was never written by Clubhouse (delivery refuses them), so there is no block of its own to take out.
    if (err.code === 'antigravity_instructions_markers') appLog('core:managed', 'warn', 'AGENTS.md has unreadable Clubhouse markers; its Antigravity block was left in', { meta: { code: err.code } });
    return;
  }
  if (!parsed.hasBlock) return;
  const rest = Buffer.concat([parsed.before, parsed.after]);
  const remove = rest.length === 0 && (await isTracked(ANTIGRAVITY_PATHS.instructions)) === false;
  await replaceIfUnchanged(file, existing.bytes, remove ? null : rest, existing.mode);
}

/**
 * For the switch to plain: `AGENTS.md` without Clubhouse's block (`outside`)
 * and with only its markers taken out, the delivered text kept as the
 * person's (`unwrapped`). Null when the file isn't there, has no block, or
 * can't be safely read.
 */
export async function antigravityPlainResults(worktree: string): Promise<{ current: Buffer; outside: Buffer; unwrapped: Buffer } | null> {
  let existing;
  let parsed: Parsed;
  try {
    existing = await readOwnFile(instructionsPath(worktree));
    if (!existing) return null;
    parsed = parseAntigravityInstructions(existing.bytes);
  } catch (err) {
    if (!isManagedStartRefused(err)) throw err;
    return null;
  }
  if (!parsed.hasBlock) return null;
  const blockEnd = existing.bytes.length - parsed.after.length;
  const block = existing.bytes.subarray(parsed.before.length, blockEnd);
  const bodyStart = BEGIN.length + (block[BEGIN.length] === 0x0d ? 2 : 1);
  const body = block.subarray(bodyStart, block.lastIndexOf(END));
  return { current: existing.bytes, outside: Buffer.concat([parsed.before, parsed.after]), unwrapped: Buffer.concat([parsed.before, body, parsed.after]) };
}

/** Write `bytes` as the worktree's AGENTS.md while it is still exactly `expected`, refusing a link. */
export async function writeAntigravityInstructionsFile(worktree: string, expected: Buffer, bytes: Buffer): Promise<void> {
  const file = instructionsPath(worktree);
  const existing = await readOwnFile(file);
  await replaceIfUnchanged(file, expected, bytes, existing?.mode);
}
