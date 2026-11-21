import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';
let root: string;
vi.mock('electron', () => ({ app: { getPath: () => root } }));
vi.mock('./chat-transcript', () => ({ transcriptPath: (agent: string, session: string) => path.join(root, 'agent-logs', 'chat', encodeURIComponent(agent).replace(/\./g, '%2E'), `${encodeURIComponent(session).replace(/\./g, '%2E')}.jsonl`) }));
import { readPassiveChatTranscript } from './passive-chat-transcript';
const roots: string[] = [];
const event = (seq: number, agentId = 'a', sessionId = 's') => ({ v: CHAT_CONTRACT_VERSION, agentId, sessionId, seq, ts: seq, type: 'session_state', data: { state: 'idle' } });
let folder: string, file: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'passive-transcript-')); roots.push(root); folder = path.join(root, 'agent-logs', 'chat', 'a'); await fs.mkdir(folder, { recursive: true }); file = path.join(folder, 's.jsonl'); });
afterAll(async () => { for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }); });
async function disk(dir: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const e of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) Object.assign(result, await disk(full, prefix + e.name + '/')); else result[prefix + e.name] = e.isSymbolicLink() ? `link:${await fs.readlink(full)}` : (await fs.readFile(full)).toString('base64'); }
  return result;
}
describe('exact-session passive transcript tail', () => {
  it('reads a bounded exact tail with damaged index/legacy files unchanged and never materializes metadata', async () => {
    await fs.writeFile(file, Array.from({ length: 2005 }, (_, i) => JSON.stringify(event(i + 1))).join('\n') + '\n');
    await fs.writeFile(path.join(folder, 'index.json'), '{broken');
    await fs.writeFile(path.join(root, 'agent-logs', 'chat', 'a.jsonl'), 'PRIVATE_LEGACY_DATA');
    const before = await disk(root);
    const got = await readPassiveChatTranscript('a', 's', 2001);
    expect(got).toHaveLength(2001); expect(got[0].seq).toBe(5); expect(got.at(-1)!.seq).toBe(2005);
    expect(await disk(root)).toEqual(before);
  });
  it('refuses missing sessions without discovery, folder creation or index recovery', async () => {
    await fs.writeFile(path.join(folder, 'index.json'), JSON.stringify({ currentSessionId: 'other', sessions: [] }));
    const before = await disk(root);
    await expect(readPassiveChatTranscript('a', 'missing', 10)).rejects.toThrow();
    await expect(readPassiveChatTranscript('absent', 's', 10)).rejects.toThrow();
    expect(await disk(root)).toEqual(before);
  });
  it.each(['leaf', 'ancestor'] as const)('refuses a %s symlink rather than reading unrelated agent data', async (mode) => {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 's.jsonl'), JSON.stringify(event(1, 'other')) + '\n');
    if (mode === 'leaf') await fs.symlink(path.join(outside, 's.jsonl'), file);
    else { await fs.rmdir(folder); await fs.symlink(outside, folder); }
    const before = await disk(root);
    await expect(readPassiveChatTranscript('a', 's', 10)).rejects.toThrow('Linked transcript path');
    expect(await disk(root)).toEqual(before);
  });
  it('refuses foreign records and a huge unbounded record, rather than returning false empty', async () => {
    await fs.writeFile(file, JSON.stringify(event(1, 'other')) + '\n');
    await expect(readPassiveChatTranscript('a', 's', 10)).rejects.toThrow('identity mismatch');
    await fs.writeFile(file, JSON.stringify(event(1)));
    await expect(readPassiveChatTranscript('a', 's', 10)).rejects.toThrow('Incomplete');
    await fs.writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    await expect(readPassiveChatTranscript('a', 's', 10)).rejects.toThrow('exceeds passive limit');
  });
});
