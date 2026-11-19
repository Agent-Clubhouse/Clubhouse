/** Exact current-session tail, never an index/legacy/recovery read. */
import * as fs from 'fs/promises';
import { constants, type BigIntStats } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { isChatEvent, type ChatEvent } from '../../../shared/chat';
import { transcriptPath } from './chat-transcript';
const MAX_BYTES = 8 * 1024 * 1024;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
export async function readPassiveChatTranscript(agentId: string, sessionId: string, tail: number): Promise<ChatEvent[]> {
  if (!agentId || !sessionId || agentId.length > 512 || sessionId.length > 512 || !Number.isSafeInteger(tail) || tail < 1 || tail > 2001) throw new Error('Invalid passive transcript scope.');
  const root = await fs.realpath(app.getPath('userData'));
  const file = transcriptPath(agentId, sessionId);
  const relative = path.relative(app.getPath('userData'), file);
  if (path.isAbsolute(relative) || relative.startsWith('..')) throw new Error('Transcript outside profile.');
  let member = root;
  const chain = new Map<string, BigIntStats>([[root, await fs.lstat(root, { bigint: true })]]);
  for (const part of relative.split(path.sep)) {
    member = path.join(member, part);
    const stat = await fs.lstat(member, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('Linked transcript path.');
    chain.set(member, stat);
  }
  const verify = async () => {
    for (const [name, original] of chain) {
      const current = await fs.lstat(name, { bigint: true });
      if (current.isSymbolicLink() || !same(original, current) || await fs.realpath(name) !== name) throw new Error('Transcript path changed.');
    }
  };
  if (!chain.get(member)!.isFile()) throw new Error('Transcript is not a file.');
  const handle = await fs.open(member, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !same(chain.get(member)!, before)) throw new Error('Transcript changed while opening.');
    await verify();
    const length = Number(before.size > BigInt(MAX_BYTES) ? BigInt(MAX_BYTES) : before.size);
    const start = Number(before.size) - length;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const part = await handle.read(bytes, read, length - read, start + read); if (!part.bytesRead) break; read += part.bytesRead; }
    const after = await handle.stat({ bigint: true });
    await verify();
    if (read !== length || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Transcript changed during read.');
    let raw = bytes.toString('utf8');
    if (start > 0) { const first = raw.indexOf('\n'); if (first < 0) throw new Error('Transcript record exceeds passive limit.'); raw = raw.slice(first + 1); }
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete passive transcript record.');
    const lines = raw.split('\n'); lines.pop(); // only complete appended records
    const events: ChatEvent[] = [];
    for (const line of lines.slice(-tail)) {
      let value: unknown; try { value = JSON.parse(line); } catch { throw new Error('Unreadable passive transcript record.'); }
      if (!isChatEvent(value) || value.agentId !== agentId || value.sessionId !== sessionId) throw new Error('Passive transcript identity mismatch.');
      events.push(value);
    }
    return events;
  } finally { await handle.close(); }
}
