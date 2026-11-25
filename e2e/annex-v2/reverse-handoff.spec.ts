import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { test, expect, connectMcp, toolWithSuffix } from './reverse-desktops';
import { isTerminalHandoff, type Handoff } from '../../src/shared/handoffs';
import { handoffE2eDiagnostics } from '../../test/handoff-e2e-diagnostics';

test.setTimeout(360_000);

test('accepted handoffs automatically transfer, verify, publish and wake in both directions over one forward', async ({ reverse }, info) => {
  for (const [sender, receiver] of reverse.directions) {
    for (const [desk, action] of [[sender, 'handoff.offer'], [receiver, 'handoff.accept']] as const) {
      await desk.app.window.evaluate(({ project, agentId, action }) => window.clubhouse.agent.setGrant(project, agentId, {
        action, target: { kind: 'any' }, mode: 'allow',
      }), { project: desk.root, agentId: desk.agentId, action });
    }
    const senderMcp = await connectMcp(sender), receiverMcp = await connectMcp(receiver);
    const config = await sender.app.window.evaluate(({ root, id }) => window.clubhouse.agent.getDurableConfig(root, id), { root: sender.root, id: sender.agentId });
    const sourceRoot = config.worktreePath || sender.root;
    const bytes = Buffer.alloc(600 * 1024, 17);
    await fs.promises.mkdir(path.join(sourceRoot, 'fixtures'), { recursive: true });
    await fs.promises.writeFile(path.join(sourceRoot, 'fixtures', 'selected.bin'), bytes);
    await fs.promises.writeFile(path.join(sourceRoot, 'fixtures', 'excluded.bin'), 'not selected');
    const prepare = await toolWithSuffix(senderMcp, 'prepare_handoff');
    const prepared = await senderMcp.call(prepare, { mode: 'worktree', include: { ignored: ['fixtures/selected.bin'] } });
    expect(prepared.isError).toBe(false);
    const preview = JSON.parse(prepared.text);
    expect(preview.ready).toBe(true);
    const offer = await toolWithSuffix(senderMcp, 'offer_handoff');
    const offered = await senderMcp.call(offer, {
      to: `${receiver.agentId}@${receiver.fingerprint}`, task: 'Continue the reverse fixture',
      brief: 'Goal: inspect the transferred fixture. Done: setup. Remaining: continue in the fresh worktree.',
      mode: 'worktree', manifest: preview.summary,
    });
    expect(offered.isError).toBe(false);
    const record = JSON.parse(offered.text) as Handoff;
    expect(record.state).toBe('offered');
    const receiverGet = await toolWithSuffix(receiverMcp, 'get_handoff');
    await expect.poll(async () => {
      const answer = await receiverMcp.call(receiverGet, { id: record.id });
      return answer.isError ? null : JSON.parse(answer.text).state;
    }, { timeout: 30_000 }).toBe('offered');
    const respond = await toolWithSuffix(receiverMcp, 'respond_to_handoff');
    expect((await receiverMcp.call(respond, { id: record.id, accept: true })).isError).toBe(false);
    const senderGet = await toolWithSuffix(senderMcp, 'get_handoff');
    let applied: Handoff | undefined;
    try {
      await expect.poll(async () => {
        const answer = await senderMcp.call(senderGet, { id: record.id });
        expect(answer.isError).toBe(false);
        applied = JSON.parse(answer.text) as Handoff;
        return isTerminalHandoff(applied.state);
      }, { timeout: 120_000 }).toBe(true);
      expect(applied?.state).toBe('applied');
    } finally {
      await info.attach(`reverse-handoff-${sender.agentId}`, { body: JSON.stringify(handoffE2eDiagnostics(applied)), contentType: 'application/json' });
    }
    expect(applied!.history.map((event) => event.state)).toContain('applying');
    const worktree = applied!.result!.worktree!;
    expect(worktree).not.toBe(receiver.root);
    const received = await fs.promises.readFile(path.join(worktree, 'fixtures', 'selected.bin'));
    expect(received.length).toBe(bytes.length);
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fs.existsSync(path.join(worktree, 'fixtures', 'excluded.bin'))).toBe(false);
    await expect.poll(async () => JSON.stringify((await receiver.fakes.report('claude', receiver.agentId)).unexpected)).toContain('Continue in fresh worktree');
    await expect.poll(() => fs.readdirSync(path.join(receiver.app.userDataDir, 'handoff-data', 'received'))).toEqual([]);
  }
});
