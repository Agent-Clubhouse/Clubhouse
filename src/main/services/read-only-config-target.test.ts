import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DISPATCHER_PROJECT_ID } from '../../shared/dispatcher-types';
import type { AgentConfigTarget } from './agent-config-reader';
const m = vi.hoisted(() => ({ root: '', controller: 'work' as string | null, chat: 'chat' as string | null }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => m.root }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherAgentId: () => m.controller, getDispatcherChatAgentId: () => m.chat }));
import { captureReadOnlyConfigTargetWitness } from './read-only-config-target';
let target: AgentConfigTarget, file: string;
beforeEach(async () => {
  m.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clubhouse-role-receipt-'))); m.controller = 'work'; m.chat = 'chat';
  const folder = path.join(m.root, 'dispatcher-chat'); await fs.mkdir(path.join(folder, '.clubhouse'), { recursive: true });
  target = { agent: { id: 'chat', name: 'Chosen chat', color: '', createdAt: '' }, project: { id: DISPATCHER_PROJECT_ID, path: folder, name: 'Dispatcher' } };
  file = path.join(folder, '.clubhouse', 'agents.json'); await fs.writeFile(file, JSON.stringify([target.agent]));
});
afterEach(async () => { await fs.rm(m.root, { recursive: true, force: true }); });
it('binds the actual role primary without discovering projects or initializing global settings and keeps receipts private', async () => {
  await fs.writeFile(path.join(m.root, 'projects.json'), 'unreadable global inventory');
  const before = await fs.readFile(file); const receipt = captureReadOnlyConfigTargetWitness(target);
  expect(receipt.current()).toBe(true); expect(receipt.current()).toBe(true); expect(JSON.stringify(receipt)).toBe('{}');
  expect(await fs.readFile(file)).toEqual(before); expect(await fs.readdir(path.dirname(file))).toEqual(['agents.json']);
  expect(await fs.readFile(path.join(m.root, 'projects.json'), 'utf8')).toBe('unreadable global inventory');
});
it.each(['removed', 'disposed', 'name-collision', 'same-bytes-replaced', 'backup-only', 'other-row-changed'])('refuses actual role primary %s after receipt admission', async (change) => {
  const receipt = captureReadOnlyConfigTargetWitness(target); const before = await fs.readFile(file);
  if (change === 'removed') await fs.writeFile(file, '[]');
  if (change === 'disposed') await fs.writeFile(file, JSON.stringify([{ ...target.agent, disposedAt: '2026-11-19' }]));
  if (change === 'name-collision') await fs.writeFile(file, JSON.stringify([{ ...target.agent, id: 'unrelated', name: 'chat' }]));
  if (change === 'same-bytes-replaced') { await fs.rename(file, `${file}.old`); await fs.writeFile(file, before); }
  if (change === 'backup-only') { await fs.rename(file, `${file}.bak`); }
  if (change === 'other-row-changed') await fs.writeFile(file, JSON.stringify([target.agent, { ...target.agent, id: 'other' }]));
  expect(receipt.current()).toBe(false);
  if (change === 'backup-only') { await expect(fs.access(file)).rejects.toThrow(); expect(await fs.readFile(`${file}.bak`)).toEqual(before); }
});
it.each(['cleared', 'replaced', 'ambiguous', 'moved-to-controller'])('refuses cached role identity %s after receipt admission', (change) => {
  const receipt = captureReadOnlyConfigTargetWitness(target);
  if (change === 'cleared') m.chat = null;
  if (change === 'replaced') m.chat = 'replacement';
  if (change === 'ambiguous') m.controller = 'chat';
  if (change === 'moved-to-controller') { m.chat = null; m.controller = 'chat'; }
  expect(receipt.current()).toBe(false);
});
it('refuses absent/ambiguous cached identities, wrong role folders, and project records colliding with cached role IDs', () => {
  m.chat = null; expect(() => captureReadOnlyConfigTargetWitness(target)).toThrow('role identity');
  m.chat = 'chat'; m.controller = 'chat'; expect(() => captureReadOnlyConfigTargetWitness(target)).toThrow('role identity');
  m.controller = 'work'; expect(() => captureReadOnlyConfigTargetWitness({ ...target, project: { ...target.project, path: path.join(m.root, 'dispatcher') } })).toThrow('role identity');
  expect(() => captureReadOnlyConfigTargetWitness({ ...target, project: { ...target.project, id: 'p' } })).toThrow('role identity');
});
it('keeps ordinary selected-project primary admission and the same final inventory fence', async () => {
  m.controller = null; m.chat = null; target.agent.id = 'ordinary'; target.project.id = 'p';
  await fs.writeFile(file, JSON.stringify([target.agent])); await fs.writeFile(path.join(m.root, 'projects.json'), JSON.stringify([target.project]));
  const receipt = captureReadOnlyConfigTargetWitness(target); expect(receipt.current()).toBe(true);
  await fs.writeFile(path.join(m.root, 'projects.json'), '[]'); expect(receipt.current()).toBe(false);
});

it('refuses ordinary inventory evidence reclassified as a role before final assembly', async () => {
  m.controller = null; m.chat = null; target.agent.id = 'ordinary'; target.project.id = 'p';
  await fs.writeFile(file, JSON.stringify([target.agent])); await fs.writeFile(path.join(m.root, 'projects.json'), JSON.stringify([target.project]));
  const receipt = captureReadOnlyConfigTargetWitness(target); m.chat = 'ordinary'; expect(receipt.current()).toBe(false);
});

it.each(['name', 'model'])('does not mint role receipts for a stale selected %s snapshot sharing the same id', (field) => {
  const stale = { ...target, agent: { ...target.agent, [field]: 'UNVERIFIED_SELECTED_VALUE' } };
  expect(() => captureReadOnlyConfigTargetWitness(stale)).toThrow('Admitted agent identity changed');
});
