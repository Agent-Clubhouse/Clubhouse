/** Human-only cross-computer approvals (#3354, #3654). */
import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { connectionApprovalView } from '../../shared/approval-routing';
import type { MobileGrantRequest } from '../../shared/mobile-control';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  self: Array(16).fill('ab').join(':'),
  rows: [{ requestId: 'gr_1', kind: 'call', actions: ['settings.app.write'], toolName: 'set_app_setting', arguments: '{}', answers: ['allow_once', 'decline'] }] as Array<Record<string, unknown>>,
  role: 'lead' as 'lead' | 'follower' | 'peer', connected: true,
  receipt: { status: 'completed', result: {} } as unknown,
  peers: [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop' }, { fingerprint: 'PHONE', role: 'member', kind: 'phone' }],
}));
vi.mock('./annex-identity', () => ({ getIdentity: () => ({ fingerprint: h.self }) }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher-federation-lead', () => ({ leadRole: () => h.role }));
vi.mock('./annex-peers', () => ({ listPeers: () => h.peers, peerNeedsPairing: (p: { needsPairing?: boolean }) => !!p.needsPairing }));
vi.mock('./annex-client', () => ({
  satelliteKeyFor: (m: string) => (m === 'laptop' ? 'LAPTOP' : undefined),
  isMachineConnected: () => h.connected,
  getSatellites: () => [{ fingerprint: 'LAPTOP', snapshot: { grantRequests: h.rows } }],
  answerRemoteGrantRequest: vi.fn(async () => h.receipt),
}));

import * as annexClient from './annex-client';
import { answerFollowerApproval } from './dispatcher-lead-approvals';

beforeEach(() => {
  h.rows = [{ requestId: 'gr_1', kind: 'call', actions: ['settings.app.write'], toolName: 'set_app_setting', arguments: '{}', answers: ['allow_once', 'decline'] }];
  h.peers = [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop' }, { fingerprint: 'PHONE', role: 'member', kind: 'phone' }];
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

  it('refuses an unrelated follower, a phone or stranger, offline, or an invalid answer', async () => {
    await expect(answerFollowerApproval('laptop', 'gr_1', 'approve')).rejects.toThrow('isn’t an answer');
    await expect(answerFollowerApproval('phone', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    await expect(answerFollowerApproval('studio', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    h.peers = [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop', needsPairing: true } as never];
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('isn’t in this Annex Network');
    h.peers = [{ fingerprint: 'LAPTOP', role: 'member', kind: 'desktop' }, { fingerprint: 'PHONE', role: 'member', kind: 'phone' }];
    h.connected = false;
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('offline');
    h.connected = true; h.role = 'follower';
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('Only the lead or a computer involved');
    expect(annexClient.answerRemoteGrantRequest).not.toHaveBeenCalled();
  });

  it.each(['follower', 'peer'] as const)('lets an involved %s answer, but rechecks the latest snapshot arguments', async (role) => {
    h.role = role;
    h.rows[0] = { ...h.rows[0], actions: ['connection.manage'], toolName: 'connect_agents', arguments: JSON.stringify({ from: 'dispatcher', to: `missing-agent@${h.self.toUpperCase()}` }) };
    const digest = createHash('sha256').update(connectionApprovalView(h.rows[0] as unknown as MobileGrantRequest)!.canonical!).digest('hex');
    await answerFollowerApproval('LAPTOP', 'gr_1', 'allow_once', digest);
    expect(annexClient.answerRemoteGrantRequest).toHaveBeenCalledWith('LAPTOP', 'gr_1', 'allow_once', digest);
    vi.mocked(annexClient.answerRemoteGrantRequest).mockClear();
    h.rows[0].arguments = JSON.stringify({ from: 'dispatcher', to: 'unrelated' });
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('computer involved');
    h.rows = [];
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('already answered');
    expect(annexClient.answerRemoteGrantRequest).not.toHaveBeenCalled();
  });

  it('keeps grantRowVisibleTo and the offered answers even for the lead', async () => {
    h.rows[0] = { ...h.rows[0], actions: ['device.manage'], toolName: 'remove_device', arguments: JSON.stringify({ id: h.self.toUpperCase() }) };
    await expect(answerFollowerApproval('laptop', 'gr_1', 'decline')).rejects.toThrow('computer involved');
    h.rows[0] = { ...h.rows[0], actions: ['connection.manage'], toolName: 'connect_agents', arguments: JSON.stringify({ from: 'dispatcher', to: `agent@${h.self}` }) };
    await expect(answerFollowerApproval('laptop', 'gr_1', 'allow_lasting')).rejects.toThrow('isn’t offered');
    expect(annexClient.answerRemoteGrantRequest).not.toHaveBeenCalled();
  });

  it('refuses an unreviewed or changed connection and the padded QA reproducer, even for the lead', async () => {
    const args = { from: 'b', to: `sensitive@${h.self}`, twoWay: true, allow: ['send_file', 'wake_agent'] };
    h.rows[0] = { ...h.rows[0], actions: ['connection.manage'], toolName: 'connect_agents', arguments: JSON.stringify(args) };
    const digest = createHash('sha256').update(connectionApprovalView(h.rows[0] as unknown as MobileGrantRequest)!.canonical!).digest('hex');
    await expect(answerFollowerApproval('laptop', 'gr_1', 'allow_once')).rejects.toThrow('changed or cannot be reviewed');
    h.rows[0].arguments = JSON.stringify({ ...args, twoWay: false });
    await expect(answerFollowerApproval('laptop', 'gr_1', 'allow_once', digest)).rejects.toThrow('changed or cannot be reviewed');
    h.rows[0].arguments = JSON.stringify({ padding: 'x'.repeat(4500), ...args }, null, 2);
    expect(connectionApprovalView(h.rows[0] as unknown as MobileGrantRequest)).toMatchObject({ from: 'b', to: args.to, twoWay: true, allow: args.allow });
    await expect(answerFollowerApproval('laptop', 'gr_1', 'allow_once', digest)).rejects.toThrow('changed or cannot be reviewed');
    expect(annexClient.answerRemoteGrantRequest).not.toHaveBeenCalled();
  });

  it.each([
    { toolName: 'set_app_setting' },
    { actions: ['settings.app.write'] },
    { actions: ['connection.manage', 'agent.reset'] },
  ])('never drops a reviewed digest after tool/actions reclassification: %j', async (change) => {
    h.rows[0] = { ...h.rows[0], actions: ['connection.manage'], toolName: 'connect_agents', arguments: JSON.stringify({ from: 'b', to: `a@${h.self}` }) };
    const reviewedDigest = createHash('sha256').update(connectionApprovalView(h.rows[0] as unknown as MobileGrantRequest)!.canonical!).digest('hex');
    h.rows[0] = { ...h.rows[0], ...change };
    await expect(answerFollowerApproval('laptop', 'gr_1', 'allow_once', reviewedDigest)).rejects.toThrow('changed or cannot be reviewed');
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
