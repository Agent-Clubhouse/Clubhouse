import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COPILOT_ACP_ARGS,
  COPILOT_PERMISSION_LEVELS,
  copilotNativeSessionExists,
  copilotPlanFilePath,
  copilotTasksAfterToolCall,
  copilotSessionStateDir,
  COPILOT_ACP_PROFILE,
  copilotAcpCapabilities,
  copilotModeKind,
  copilotVersionStatus,
  dedupeCopilotConfigOptions,
  dedupeCopilotLegacyModels,
  filterCopilotUpdate,
  resolveCopilotAcpSpawn,
  selectAcpProfile,
} from './copilot-acp';
import { GENERIC_ACP_PROFILE, type AcpTask } from './acp-session';
import { terminalLoginCommand } from './acp-capabilities';
import { loadAcpFixture } from './__fixtures__/acp/acp-replay';
import type { InitializeResponse, NewSessionResponse, SessionConfigSelect, SessionUpdate } from './acp-schema';

const recording = loadAcpFixture('copilot-cli', 'handshake-list-close.jsonl');
const init = recording.find((r) => r.dir === 'in' && r.msg.id === 1)!.msg.result as InitializeResponse;
const newSession = recording.find((r) => r.dir === 'in' && r.msg.id === 2)!.msg.result as NewSessionResponse;

describe('Copilot ACP launch', () => {
  it('launches ACP over stdio, running the same Copilot as Terminal (no --no-auto-update, #2154)', () => {
    expect(COPILOT_ACP_ARGS).toEqual(['--acp', '--stdio']);
  });

  it('appends launch-only flags after the ACP flags', () => {
    const cmd = resolveCopilotAcpSpawn({ binary: 'copilot', extraArgs: ['--deny-tool=shell(rm)'] });
    expect(cmd.binary).toBe('copilot');
    expect(cmd.args).toEqual(['--acp', '--stdio', '--deny-tool=shell(rm)']);
  });
});

describe('Copilot model-list dedupe', () => {
  it('collapses the recorded duplicate models, keeping the entry with cost metadata', () => {
    const model = newSession.configOptions!.find((o) => o.id === 'model') as SessionConfigSelect;
    const before = model.options as Array<{ value: string; _meta?: Record<string, unknown> | null }>;
    const uniqueValues = new Set(before.map((o) => o.value));
    expect(before.length).toBeGreaterThan(uniqueValues.size);

    const after = (dedupeCopilotConfigOptions([model])[0] as SessionConfigSelect).options as typeof before;
    expect(after.map((o) => o.value)).toEqual([...uniqueValues]);
    expect(after.find((o) => o.value === 'auto')?._meta).toMatchObject({ copilotUsage: '1x' });
  });

  it('dedupes the legacy models list the same way', () => {
    const models = newSession.models!;
    const deduped = dedupeCopilotLegacyModels(models);
    expect(deduped.availableModels.length).toBe(new Set(models.availableModels.map((m) => m.modelId)).size);
    expect(deduped.currentModelId).toBe(models.currentModelId);
  });

  it('dedupes inside option groups and leaves booleans alone', () => {
    const out = dedupeCopilotConfigOptions([
      {
        type: 'select', id: 'model', name: 'Model', currentValue: 'a',
        options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'a', name: 'A', _meta: { x: 1 } }] }],
      },
      { type: 'boolean', id: 'flag', name: 'Flag', currentValue: true },
    ]);
    const groups = (out[0] as SessionConfigSelect).options as Array<{ options: Array<{ _meta?: unknown }> }>;
    expect(groups[0].options).toEqual([{ value: 'a', name: 'A', _meta: { x: 1 } }]);
    expect(out[1]).toEqual({ type: 'boolean', id: 'flag', name: 'Flag', currentValue: true });
  });
});

describe('Copilot stray Info line', () => {
  const chunk = (text: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const open = { openToolCallIds: new Set(['call_1']) };
  const none = { openToolCallIds: new Set<string>() };

  it('drops an Info path chunk while a tool call is open', () => {
    expect(filterCopilotUpdate(chunk('Info: /workspace/project/hello.txt'), open)).toBeNull();
    expect(filterCopilotUpdate(chunk('Info: C:\\work\\hello.txt'), open)).toBeNull();
  });

  it('keeps it when no tool call is open, and keeps ordinary prose', () => {
    expect(filterCopilotUpdate(chunk('Info: /workspace/project/hello.txt'), none)).not.toBeNull();
    expect(filterCopilotUpdate(chunk('Info: the file was created'), open)).not.toBeNull();
  });
});

describe('Copilot capability record', () => {
  it('records what Copilot 1.0.92 does and does not support', () => {
    const caps = copilotAcpCapabilities(init);
    expect(caps).toMatchObject({
      profile: 'copilot',
      agent: { name: 'Copilot', version: '1.0.92' },
      resume: 'load',
      listSessions: true,
      listIsMachineWide: true,
      closeSession: true,
      deleteSession: false,
      steer: false,
      queue: 'client',
      rewind: false,
      planApproval: false,
      subagents: 'unverified',
      permissionOptionKinds: ['allow_once', 'allow_always', 'reject_once'],
      permissionRules: 'launch_only',
      usage: { context: true, turnTokens: true, cost: false },
      prompt: { image: true, audio: false, embeddedContext: true },
      // Copilot drops client stdio servers over ACP (#2240).
      mcp: { stdio: false, http: true, sse: true },
      login: 'terminal',
      clientFs: false,
    });
    expect(caps.quirks).toContain('model-list-duplicates');
    expect(caps.quirks).not.toContain('untested-version');
  });

  it('flags versions outside the tested range', () => {
    expect(copilotVersionStatus('1.0.92')).toBe('tested');
    expect(copilotVersionStatus('1.0.98')).toBe('tested');
    expect(copilotVersionStatus('1.0.100-0')).toBe('newer');
    expect(copilotVersionStatus('1.0.82')).toBe('tested');
    expect(copilotVersionStatus('1.0.40')).toBe('older');
    expect(copilotVersionStatus(undefined)).toBe('unknown');
    const caps = copilotAcpCapabilities({ ...init, agentInfo: { name: 'Copilot', version: '1.1.0' } });
    expect(caps.quirks).toContain('untested-version');
  });

  it('reads the terminal login command from the legacy _meta convention', () => {
    expect(terminalLoginCommand(init, 'copilot')).toEqual({
      command: '/usr/local/bin/copilot',
      args: ['login'],
      label: 'Copilot Login',
    });
  });
});

describe('Copilot helpers', () => {
  it('maps URI mode ids to mode kinds', () => {
    expect(copilotModeKind('https://agentclientprotocol.com/protocol/session-modes#plan')).toBe('plan');
    expect(copilotModeKind('https://agentclientprotocol.com/protocol/session-modes#autopilot')).toBe('autopilot');
    expect(copilotModeKind('custom')).toBeUndefined();
  });

  it('selects the Copilot profile only for Copilot', () => {
    expect(selectAcpProfile(init)).toBe(COPILOT_ACP_PROFILE);
    expect(selectAcpProfile({ protocolVersion: 1, agentInfo: { name: 'gemini-cli', version: '1.0.0' } })).toBe(GENERIC_ACP_PROFILE);
  });
});

describe('Copilot native session lookup (#2155)', () => {
  it('finds sessions under $COPILOT_HOME/session-state, defaulting to ~/.copilot', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    fs.mkdirSync(path.join(home, 'session-state', 'bc755b6e-1'), { recursive: true });
    expect(copilotSessionStateDir({ COPILOT_HOME: home })).toBe(path.join(home, 'session-state'));
    expect(copilotSessionStateDir({})).toBe(path.join(os.homedir(), '.copilot', 'session-state'));
    await expect(copilotNativeSessionExists('bc755b6e-1', { COPILOT_HOME: home })).resolves.toBe(true);
    await expect(copilotNativeSessionExists('a27ef93a-missing', { COPILOT_HOME: home })).resolves.toBe(false);
  });

  it('never uses an id that is not a plain token as a path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    fs.mkdirSync(path.join(home, 'outside'), { recursive: true });
    await expect(copilotNativeSessionExists(path.join('..', 'outside'), { COPILOT_HOME: path.join(home, 'x') })).resolves.toBe(false);
    await expect(copilotNativeSessionExists('', { COPILOT_HOME: home })).resolves.toBe(false);
  });
});

describe('Copilot level re-send', () => {
  function fakeSession(allowAll: string, mode: string) {
    const calls: string[] = [];
    const state = {
      modes: { currentModeId: `https://agentclientprotocol.com/protocol/session-modes#${mode}`, availableModes: [] as unknown[] },
      configOptions: [{ type: 'select', id: 'allow_all', name: 'Allow All', currentValue: allowAll, options: [] as unknown[] }],
    };
    const session = {
      getState: () => state,
      setConfigOption: vi.fn(async (id: string, value: string) => { calls.push(`${id}=${value}`); }),
      setMode: vi.fn(async (id: string) => { calls.push(`mode=${id.split('#')[1]}`); }),
    };
    return { session: session as unknown as Parameters<typeof COPILOT_PERMISSION_LEVELS.apply>[0], calls };
  }

  it('skips settings that already match on a fresh session', async () => {
    const { session, calls } = fakeSession('on', 'agent');
    await COPILOT_PERMISSION_LEVELS.apply(session, 'full_access');
    expect(calls).toEqual([]);
  });

  it('re-sends allow_all and mode after a resume, even when they report as set (#2155)', async () => {
    const { session, calls } = fakeSession('on', 'agent');
    await COPILOT_PERMISSION_LEVELS.apply(session, 'full_access', { force: true });
    expect(calls).toEqual(['allow_all=on', 'mode=agent']);
  });
});

describe('Copilot plan mode (#2176)', () => {
  const home = path.join(os.tmpdir(), 'copilot-home');
  const sid = 'd71aeae6-cc77-49f5-b5a3-12c313ea0959';
  const ctx = { sessionId: sid, env: { COPILOT_HOME: home } };
  const planFile = path.join(home, 'session-state', sid, 'plan.md');

  it("recognises only this session's plan file", () => {
    expect(copilotPlanFilePath(['/workspace/project/src/a.ts', planFile], ctx)).toBe(planFile);
    // Normalised: redundant segments still name the same file.
    const roundabout = path.join(home, 'session-state', sid, '..', sid, '.', 'plan.md');
    expect(copilotPlanFilePath([roundabout], ctx)).toBe(roundabout);
  });

  it('treats a workspace plan.md as an ordinary file', () => {
    expect(copilotPlanFilePath([path.join(os.tmpdir(), 'project', 'plan.md')], ctx)).toBeUndefined();
    expect(copilotPlanFilePath([path.join(os.tmpdir(), 'project', 'session-state', sid, 'plan.md')], ctx)).toBeUndefined();
    expect(copilotPlanFilePath(['plan.md'], ctx)).toBeUndefined();
  });

  it("treats another session's plan.md as an ordinary file", () => {
    const other = path.join(home, 'session-state', '90936e2a-b030-43d9-9924-44a66e171a4a', 'plan.md');
    expect(copilotPlanFilePath([other], ctx)).toBeUndefined();
    expect(copilotPlanFilePath([planFile], { ...ctx, sessionId: null })).toBeUndefined();
    expect(copilotPlanFilePath([planFile], { ...ctx, sessionId: '../x' })).toBeUndefined();
  });

  // The statement Copilot 1.0.98 ran in the live test ("Store changelog plan todos").
  const insert = {
    description: 'Store changelog plan todos',
    query: "INSERT OR REPLACE INTO todos (id, title, description, status) VALUES\n  ('draft-fictional-fix-entry', 'Drafting fictional fix entry', 'Write a concise, user-facing description; don''t mention internals.', 'pending'),\n  ('place-release-note-entry', 'Placing release note entry', 'Add it (in order).', 'pending');",
  };

  it('turns the todos insert into tasks', () => {
    expect(copilotTasksAfterToolCall(insert, [])).toEqual([
      { id: 'draft-fictional-fix-entry', content: 'Drafting fictional fix entry', status: 'pending' },
      { id: 'place-release-note-entry', content: 'Placing release note entry', status: 'pending' },
    ]);
  });

  it('applies status updates, by id or IN list, and deletes', () => {
    const tasks = copilotTasksAfterToolCall(insert, [])!;
    const started = copilotTasksAfterToolCall({ query: "UPDATE todos SET status = 'in_progress' WHERE id = 'draft-fictional-fix-entry'" }, tasks)!;
    expect(started.map((t) => t.status)).toEqual(['in_progress', 'pending']);
    const done = copilotTasksAfterToolCall({ query: "UPDATE todos SET status = 'done' WHERE id IN ('draft-fictional-fix-entry', 'place-release-note-entry');" }, started)!;
    expect(done.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(copilotTasksAfterToolCall({ query: "DELETE FROM todos WHERE id = 'place-release-note-entry'" }, done)!.map((t) => t.id)).toEqual(['draft-fictional-fix-entry']);
  });

  // A whole real session's todo calls (Copilot session 44568680…, events.jsonl).
  const realSession = [
    "INSERT OR REPLACE INTO todos (id, title, description, status) VALUES ('terminal-edge-fix', 'Projecting terminal task edges', 'Update deriveTraversedEdges so run.finished selects the current task outgoing terminal edge for complete, abort, and escalate outcomes.', 'in_progress'), ('terminal-edge-tests', 'Covering terminal replay paths', 'Add focused runDetailData regression tests for task-to-terminal replay and run the portal targeted tests.', 'pending'), ('commit-repass', 'Committing reviewer fix', 'Commit the scoped reviewer-requested fix and write the required result envelope.', 'pending')",
    "UPDATE todos SET status = CASE id WHEN 'terminal-edge-fix' THEN 'done' WHEN 'terminal-edge-tests' THEN 'in_progress' ELSE status END WHERE id IN ('terminal-edge-fix', 'terminal-edge-tests')",
    "UPDATE todos SET status = CASE id WHEN 'terminal-edge-tests' THEN 'done' WHEN 'commit-repass' THEN 'in_progress' ELSE status END WHERE id IN ('terminal-edge-tests', 'commit-repass')",
    "UPDATE todos SET status = 'done' WHERE id = 'commit-repass'",
  ];

  it('applies CASE id WHEN … THEN … updates, as a real session sent them', () => {
    const statuses: string[][] = [];
    let tasks: AcpTask[] = [];
    for (const query of realSession) {
      tasks = copilotTasksAfterToolCall({ description: 'Update todos', query }, tasks)!;
      expect(tasks).toBeDefined();
      statuses.push(tasks.map((t) => t.status));
    }
    expect(statuses).toEqual([
      ['in_progress', 'pending', 'pending'],
      ['completed', 'in_progress', 'pending'],
      ['completed', 'completed', 'in_progress'],
      ['completed', 'completed', 'completed'],
    ]);
  });

  it('applies the other real update shapes: CASE WHEN, LIKE, extra columns, several statements', () => {
    const seed = (ids: string[], status = 'pending'): AcpTask[] => ids.map((id) => ({ id, content: id, status: status as AcpTask['status'] }));
    // 62912d53…: a searched CASE.
    const curated = copilotTasksAfterToolCall({ query: "UPDATE todos SET status=CASE WHEN id='write-result' THEN 'in_progress' ELSE 'done' END WHERE id IN ('curate-32','curate-33','curate-253','curate-903','curate-917','curate-1197','curate-1224','curate-1300','curate-1308','curate-1448','curate-1578','write-result')" },
      seed(['curate-32', 'curate-33', 'other', 'write-result']))!;
    expect(curated.map((t) => t.status)).toEqual(['completed', 'completed', 'pending', 'in_progress']);
    // 00ae7c8c…: CASE id, an updated_at column, WHERE id LIKE.
    const proto = copilotTasksAfterToolCall({ query: "UPDATE todos SET status = CASE id WHEN 'prototype-foundation' THEN 'done' WHEN 'prototype-overview' THEN 'done' WHEN 'prototype-run' THEN 'done' WHEN 'prototype-validate' THEN 'in_progress' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id LIKE 'prototype-%'" },
      seed(['prototype-foundation', 'prototype-run', 'prototype-validate', 'prototype-ship', 'ship']))!;
    expect(proto.map((t) => t.status)).toEqual(['completed', 'completed', 'in_progress', 'pending', 'pending']);
    // 141bd820…: several statements, a description with quotes, todo_deps and SELECT mixed in.
    const multi = copilotTasksAfterToolCall({ query: "UPDATE todos SET status='done', description='Goobers #3876 D1 landed via PR #3920 as 5fac00cb7c40e8947a9b8d9365c9a46568250d28 with all seven engine-delegation pieces and 22 green CI checks. Live engine/Temporal proof remains after deployment.' WHERE id='implement-3876-d1'; UPDATE todos SET status='done' WHERE id LIKE 'd1-%'; INSERT OR IGNORE INTO todo_deps (todo_id,depends_on) VALUES ('deploy-engine-cutover','implement-3876-d1'); SELECT id,status FROM todos WHERE id IN ('implement-3876-d1','implement-3877-d2','implement-3883-hitl','implement-3884-kit-staleness') ORDER BY id" },
      seed(['implement-3876-d1', 'd1-a', 'd1-b', 'deploy-engine-cutover']))!;
    expect(multi.map((t) => t.status)).toEqual(['completed', 'completed', 'completed', 'pending']);
    // 141bd820…: DELETE everything, then a fresh INSERT, in one call.
    const reset = copilotTasksAfterToolCall({ query: "DELETE FROM todo_deps; DELETE FROM todos;\nINSERT INTO todos (id, title, description, status) VALUES\n('recon', 'Re-establishing live state and worktrees', 'Confirm cluster condition persists.', 'in_progress')" },
      seed(['old']))!;
    expect(reset).toEqual([{ id: 'recon', content: 'Re-establishing live state and worktrees', status: 'in_progress' }]);
  });

  it('reports no change when nothing actually changes', () => {
    const tasks = copilotTasksAfterToolCall({ query: realSession[0] }, [])!;
    // ab6985ff…: only the description changes.
    expect(copilotTasksAfterToolCall({ query: "UPDATE todos SET description = description || ' Baseline make is being verified separately.' WHERE id = 'terminal-edge-fix';" }, tasks)).toBeUndefined();
    // Same status again, an unknown id, a CASE that matches nothing.
    expect(copilotTasksAfterToolCall({ query: "UPDATE todos SET status = 'in_progress' WHERE id = 'terminal-edge-fix'" }, tasks)).toBeUndefined();
    expect(copilotTasksAfterToolCall({ query: "UPDATE todos SET status = 'done' WHERE id = 'nope'" }, tasks)).toBeUndefined();
    expect(copilotTasksAfterToolCall({ query: realSession[1].replace(/terminal-edge-/g, 'x-') }, tasks)).toBeUndefined();
    expect(copilotTasksAfterToolCall({ query: realSession[0] }, tasks)).toBeUndefined();
  });

  it('deletes by status, not by treating the status as an id', () => {
    const tasks: AcpTask[] = [
      { id: 'done', content: 'A task whose id is done', status: 'pending' },
      { id: 'b', content: 'Finished', status: 'completed' },
      { id: 'c', content: 'Running', status: 'in_progress' },
    ];
    expect(copilotTasksAfterToolCall({ query: "DELETE FROM todos WHERE status='done'" }, tasks)!.map((t) => t.id)).toEqual(['done', 'c']);
    expect(copilotTasksAfterToolCall({ query: "DELETE FROM todos WHERE status IN ('done', 'in_progress')" }, tasks)!.map((t) => t.id)).toEqual(['done']);
    // A filter it can't read leaves the list alone.
    expect(copilotTasksAfterToolCall({ query: "DELETE FROM todos WHERE created_at < date('now')" }, tasks)).toBeUndefined();
    expect(copilotTasksAfterToolCall({ query: "DELETE FROM todos WHERE id = 'b' OR id = 'c'" }, tasks)).toBeUndefined();
  });

  it('splits a large query in linear time', () => {
    // A long run of `;` after the last quote was the old splitter's worst case (1.4s+ for 40KB).
    const query = realSession[0] + ';\n' + realSession[3] + ";\nUPDATE todos SET title = 'a ; quoted '' semicolon' WHERE id = 'commit-repass';" + ';'.repeat(40_000);
    expect(query.length).toBeGreaterThan(40_000);
    const started = performance.now();
    const tasks = copilotTasksAfterToolCall({ query }, [])!;
    expect(performance.now() - started).toBeLessThan(250);
    expect(tasks.find((t) => t.id === 'commit-repass')).toEqual({ id: 'commit-repass', content: "a ; quoted ' semicolon", status: 'completed' });
  });

  it('ignores queries that do not change todos', () => {
    expect(copilotTasksAfterToolCall({ query: 'SELECT * FROM todos' }, [])).toBeUndefined();
    expect(copilotTasksAfterToolCall({ query: "INSERT INTO notes (id) VALUES ('x')" }, [])).toBeUndefined();
    expect(copilotTasksAfterToolCall({ command: 'ls' }, [])).toBeUndefined();
  });
});
