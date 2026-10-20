import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exitListeners = vi.hoisted(() => [] as Array<(id: string, code: number) => void>);
vi.mock('../services/agent-exit-broadcast', () => ({ onAgentExit: (fn: (id: string, code: number) => void) => exitListeners.push(fn) }));

import { ATTR } from '../../shared/telemetry/attributes';
import {
  EARLY_FAILURE_MS,
  _activeRunsForTests,
  _resetAgentTelemetryForTests,
  agentKillRequested,
  agentKillStage,
  agentOutput,
  agentRunKilled,
  agentRunStarted,
  agentShellReady,
  agentSwept,
  classifyExit,
  installAgentTelemetry,
  noteSpawnKind,
} from './agent-telemetry';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import type { TelemetryRuntime } from './types';

function fakeRuntime(): TelemetryRuntime {
  return {
    level: 'standard', flow: vi.fn(), step: vi.fn(), count: vi.fn(), event: vi.fn(), exception: vi.fn(),
    replaySpan: vi.fn(), replayTree: vi.fn(), recentExports: () => [], preview: () => [],
    forceFlush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  } as unknown as TelemetryRuntime;
}

let rt: TelemetryRuntime;
const exit = (id: string, code: number) => exitListeners.forEach((fn) => fn(id, code));

beforeEach(() => {
  exitListeners.length = 0;
  rt = fakeRuntime();
  setProducingRuntime(rt);
  installAgentTelemetry((id) => (id.startsWith('cx') ? 'codex-cli' : 'claude-code'));
});
afterEach(() => {
  setProducingRuntime(null);
  _resetAgentTelemetryForTests();
});

describe('classifyExit', () => {
  const start = 1000;
  it.each([
    [{ swept: true, startMs: start }, 1, start + 10_000, 'stale_swept'],
    [{ swept: false, killStage: 'sigkill' as const, startMs: start }, 1, start + 10_000, 'killed_escalated'],
    [{ swept: false, killStage: 'exit_command' as const, startMs: start }, 0, start + 10_000, 'killed_user'],
    [{ swept: false, startMs: start }, 0, start + 100, 'completed'],
    [{ swept: false, startMs: start }, 1, start + EARLY_FAILURE_MS - 1, 'early_failure'],
    [{ swept: false, startMs: start }, 2, start + EARLY_FAILURE_MS + 1, 'failed'],
  ])('%o code %s → %s', (run, code, at, expected) => {
    expect(classifyExit(run, code, at)).toBe(expected);
  });
});

describe('agent runs', () => {
  it('records readiness once, accumulates bytes, and replays the run at exit', () => {
    agentRunStarted('a1', 'pty', Date.now() - 5000);
    agentShellReady('a1');
    agentShellReady('a1');
    agentOutput('a1', 100);
    agentOutput('a1', 50);
    exit('a1', 0);
    const counts = (rt.count as ReturnType<typeof vi.fn>).mock.calls;
    expect(counts.filter((c) => c[0] === 'clubhouse.agent.time_to_shell_ready')).toHaveLength(1);
    expect(counts.filter((c) => c[0] === 'clubhouse.agent.time_to_first_output')).toHaveLength(1);
    expect(counts).toContainEqual(['clubhouse.pty.output.bytes', 150, [ATTR.agentRuntime('pty'), ATTR.orchestrator('claude-code')]]);
    expect(counts).toContainEqual(['clubhouse.agent.runs', 1, [ATTR.agentRuntime('pty'), ATTR.orchestrator('claude-code'), ATTR.agentExitClass('completed')]]);
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({ name: 'clubhouse.agent.run', outcome: 'ok' }));
    expect(_activeRunsForTests()).toBe(0);
  });

  it('classifies an escalated kill and counts the escalations', () => {
    agentRunStarted('cx1', 'headless');
    agentKillStage('cx1', 'sigterm');
    agentKillStage('cx1', 'exit_command'); // never moves backwards
    agentKillStage('cx1', 'sigkill');
    exit('cx1', 137);
    const counts = (rt.count as ReturnType<typeof vi.fn>).mock.calls;
    // The first stage of a kill is not an escalation.
    expect(counts.filter((c) => c[0] === 'clubhouse.agent.kill.escalations')).toEqual([
      ['clubhouse.agent.kill.escalations', 1, [ATTR.killStage('sigkill')]],
    ]);
    expect(counts).toContainEqual(['clubhouse.agent.runs', 1, [ATTR.agentRuntime('headless'), ATTR.orchestrator('codex-cli'), ATTR.agentExitClass('killed_escalated')]]);
  });

  it('ends a hard-killed run as a user kill at sigkill', () => {
    agentRunStarted('a4', 'pty');
    agentRunKilled('a4', 'sigkill');
    exit('a4', 1); // a late exit after the kill is ignored
    expect(rt.replaySpan).toHaveBeenCalledTimes(1);
    expect(rt.replaySpan).toHaveBeenCalledWith(expect.objectContaining({
      name: 'clubhouse.agent.run',
      outcome: 'cancelled',
      attrs: expect.arrayContaining([ATTR.agentExitClass('killed_user'), ATTR.killStage('sigkill')]),
    }));
    expect((rt.count as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === 'clubhouse.agent.kill.escalations')).toBe(false);
  });

  it('carries the kind spawnAgent noted, and replays a kill span from the request to the exit', () => {
    noteSpawnKind('a5', 'durable');
    agentRunStarted('a5', 'pty', 1000);
    agentKillRequested('a5', 'agent_tool', 2000);
    agentKillStage('a5', 'exit_command');
    agentKillStage('a5', 'eof');
    exitListeners.forEach((fn) => fn('a5', 0));
    const counts = (rt.count as ReturnType<typeof vi.fn>).mock.calls;
    expect(counts.find((c) => c[0] === 'clubhouse.agent.runs')?.[2]).toContainEqual(ATTR.agentKind('durable'));
    const kill = (rt.replaySpan as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).find((sp) => sp.name === 'clubhouse.agent.kill');
    expect(kill).toMatchObject({ startMs: 2000, outcome: 'ok' });
    expect(kill.attrs).toEqual(expect.arrayContaining([
      ATTR.killTrigger('agent_tool'), ATTR.killStage('eof'), ATTR.agentExitClass('killed_user'),
    ]));
  });

  it('closes a replaced run and labels a swept one', () => {
    agentRunStarted('a2', 'pty');
    agentRunStarted('a2', 'pty');
    agentSwept('a2');
    exit('a2', 1);
    const runs = (rt.count as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'clubhouse.agent.runs').map((c) => c[2][2]);
    expect(runs).toEqual([ATTR.agentExitClass('replaced'), ATTR.agentExitClass('stale_swept')]);
  });

  it('ignores exits it never saw start (e.g. chat runs) and tracks nothing while off', () => {
    exit('unknown', 0);
    setProducingRuntime(null);
    agentRunStarted('a3', 'pty');
    expect(_activeRunsForTests()).toBe(0);
    expect(rt.count).not.toHaveBeenCalled();
  });
});
