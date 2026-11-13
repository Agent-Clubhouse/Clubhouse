/** Approvals from other computers, answered in the lead's chat (#3354). */
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'lead' as 'lead' | 'follower' | 'peer', connected: true,
  receipt: { status: 'completed', result: {} } as unknown,
  peers: [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop' }, { fingerprint: 'PHONE', role: 'member', kind: 'phone' }],
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher-federation-lead', () => ({ leadRole: () => h.role }));
vi.mock('./annex-peers', () => ({ listPeers: () => h.peers, peerNeedsPairing: (p: { needsPairing?: boolean }) => !!p.needsPairing }));
vi.mock('./annex-client', () => ({
  satelliteKeyFor: (m: string) => (m === 'laptop' ? 'LAPTOP' : undefined),
  isMachineConnected: () => h.connected,
  answerRemoteGrantRequest: vi.fn(async () => h.receipt),
}));

import * as annexClient from './annex-client';
import { answerFollowerApproval } from './dispatcher-lead-approvals';

beforeEach(() => {
  h.role = 'lead'; h.connected = true; h.receipt = { status: 'completed', result: {} };
  vi.mocked(annexClient.answerRemoteGrantRequest).mockClear();
});

describe('answering another computer’s request from the lead (#3354)', () => {
  it('sends the person’s answer to the computer it came from', async () => {
    await answerFollowerApproval('LAPTOP', 'gr_1', 'allow_once');
    expect(annexClient.answerRemoteGrantRequest).toHaveBeenCalledWith('LAPTOP', 'gr_1', 'allow_once');
  });

  it('says plainly when it was already answered there, or ended', async () => {
    h.receipt = { status: 'rejected', error: { code: 'grant_request_not_found', message: 'grant_request_not_found' } };
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('It was already answered, or it ended, on that computer.');
  });

  it('refuses off the lead, for a phone or stranger, offline, or an answer no request takes', async () => {
    await expect(answerFollowerApproval('laptop', 'gr_1', 'approve')).rejects.toThrow('isn’t an answer');
    await expect(answerFollowerApproval('phone', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    await expect(answerFollowerApproval('studio', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    h.peers = [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop', needsPairing: true } as never];
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    h.peers = [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop' }, { fingerprint: 'PHONE', role: 'member', kind: 'phone' }];
    h.connected = false;
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('offline');
    h.connected = true; h.role = 'follower';
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('Only the lead');
    expect(annexClient.answerRemoteGrantRequest).not.toHaveBeenCalled();
  });

  it('only a person’s click reaches it: no tool, controller link or message calls it', () => {
    const root = path.resolve(__dirname, '..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(full);
      }
    };
    walk(root);
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    const callers = sources.filter((f) => /\banswerFollowerApproval\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    expect(callers).toEqual(['ipc/dispatcher-handlers.ts', 'services/dispatcher-lead-approvals.ts']);
    const senders = sources.filter((f) => /\banswerRemoteGrantRequest\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    expect(senders).toEqual(['services/annex-client.ts', 'services/dispatcher-lead-approvals.ts']);
    // The one place this computer sends grant.answer to another, and the renderer's chat commands can't.
    const client = fs.readFileSync(path.join(root, 'services', 'annex-client.ts'), 'utf8');
    expect(client.match(/'grant\.answer'/g)).toHaveLength(1);
    const sender = client.slice(client.indexOf('export function answerRemoteGrantRequest('));
    expect(sender.slice(0, sender.indexOf('\n}\n')).includes("'grant.answer'")).toBe(true);
    const chatCommands = client.slice(client.indexOf('export const REMOTE_CHAT_COMMANDS'), client.indexOf('\n', client.indexOf('export const REMOTE_CHAT_COMMANDS')));
    expect(chatCommands).not.toContain('grant');
  });
});
