import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/handoffs';
vi.mock('./base-dir', () => ({ getBaseDirPath: () => os.tmpdir() }));
import { recordFederationHandoff } from './dispatcher-federation-handoffs';
import { parseTopicPage } from './dispatcher/dispatcher-memory';
let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
it('retains a discoverable agreement record and deduplicates replay', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'federation-handoff-memory-'));
  const from = { machine: Array(16).fill('aa').join(':'), agentId: 'project-agent' };
  const at = Date.now();
  const record: Handoff = { schemaVersion: 1, id: randomUUID(), createdAt: at, updatedAt: at, version: 1, from,
    to: { machine: Array(16).fill('bb').join(':'), via: 'dispatcher' }, task: { title: 'Continue work', brief: 'Finish the remaining checks.' }, mode: 'worktree', state: 'offered',
    history: [{ operationId: randomUUID(), state: 'offered', at, by: { kind: 'agent', address: from } }] };
  await recordFederationHandoff(record, 'Concierge on Laptop', root);
  await recordFederationHandoff(record, 'Concierge on Laptop', root);
  const files = await fs.readdir(path.join(root, 'topics'));
  expect(files).toHaveLength(1);
  expect(files[0]).not.toContain(':');
  const page = parseTopicPage(await fs.readFile(path.join(root, 'topics', files[0]), 'utf8'))!;
  expect(page.status).toBe('confirmed');
  expect(page.body).toContain('Local sending agent: "project-agent"');
  expect(page.body).toContain('Concierge on Laptop');
  expect(page.body).toContain('never grants approval');
  const timeline = await fs.readFile(path.join(root, 'timeline', (await fs.readdir(path.join(root, 'timeline')))[0]), 'utf8');
  expect(timeline.match(/version 1/g)).toHaveLength(1);
  expect(timeline).toContain(`../topics/${files[0]}`);
});
