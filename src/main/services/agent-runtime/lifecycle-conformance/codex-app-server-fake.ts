/**
 * A scripted `codex app-server` process for the lifecycle conformance suite
 * and its gap tests, behind the same mocked-spawn seam the Codex driver tests
 * use. Message shapes come from the pinned v2 fixtures. Turn identity is
 * modeled: a turn/start while a turn is accepted or running answers with that
 * turn (the shared-turn shape #3783 handles). That models the documented
 * receipt; it is not a recording. Writes after the process exits are dropped,
 * as a closed pipe would.
 */
import { EventEmitter } from 'events';
import type { TurnStopReason } from '../../../../shared/chat';
import * as fx from '../../../orchestrators/adapters/codex-protocol/__fixtures__/app-server-session';
import { CodexChatDriver } from '../../../orchestrators/adapters/codex-chat-driver';
import type { ConformanceSubject, NativeControl } from './types';

type Reply = { result?: unknown; error?: { code: number; message: string } };

interface Turn { id: string; started: boolean; ended: boolean }

function turnOf(id: string, status: 'inProgress' | 'completed' | 'interrupted' | 'failed') {
  return {
    ...fx.turnStartResult.turn,
    id,
    status,
    ...(status === 'failed' && { error: { message: 'turn failed', codexErrorInfo: null, additionalDetails: null, misalignment: null } }),
  };
}

const STATUS: Partial<Record<TurnStopReason, 'completed' | 'interrupted' | 'failed'>> = {
  end_turn: 'completed', cancelled: 'interrupted', error: 'failed',
};

/** One app-server process: answers the driver's requests and plays the provider side. */
export function createCodexAppServer() {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  const received: Array<Record<string, unknown>> = [];
  const turns: Turn[] = [];
  let nextTurn = 1;
  let nextRequest = 100;
  let failNext = false;
  const send = (msg: unknown) => stdout.emit('data', JSON.stringify(msg) + '\n');
  const running = () => turns.find((t) => t.started && !t.ended);
  const settle = (turn: Turn, status: 'completed' | 'interrupted' | 'failed') => {
    turn.ended = true;
    send({ method: 'turn/completed', params: { threadId: fx.THREAD_ID, turn: turnOf(turn.id, status) } });
  };
  const handlers: Record<string, (params: Record<string, unknown>) => Reply> = {
    initialize: () => ({ result: fx.initializeResult }),
    'thread/start': () => ({ result: fx.threadStartResult }),
    'thread/resume': () => ({ result: fx.threadResumeResult }),
    'turn/start': () => {
      if (failNext) {
        failNext = false;
        return { error: { code: -32603, message: 'turn/start failed' } };
      }
      // Modeled: a turn/start while a turn is open joins it.
      let turn = turns.find((t) => !t.ended);
      if (!turn) {
        turn = { id: `turn-${nextTurn++}`, started: false, ended: false };
        turns.push(turn);
      }
      return { result: { turn: turnOf(turn.id, 'inProgress') } };
    },
    'turn/steer': () => ({ result: { turnId: running()?.id ?? '' } }),
    'turn/interrupt': () => {
      const turn = running();
      if (turn) queueMicrotask(() => settle(turn, 'interrupted'));
      return { result: {} };
    },
  };
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null as number | null,
    pid: 1,
    kill: (() => {
      if (proc.exitCode !== null) return;
      proc.exitCode = 0;
      proc.emit('exit', null, 'SIGTERM');
    }),
    stdin: {
      writable: true,
      write: ((chunk: string) => {
        if (proc.exitCode !== null) return false;
        const msg = JSON.parse(chunk);
        received.push(msg);
        if (msg.id !== undefined && typeof msg.method === 'string') {
          const reply = handlers[msg.method]?.(msg.params) ?? { result: {} };
          send({ id: msg.id, ...reply });
        }
        return true;
      }),
    },
  });

  const control: NativeControl = {
    received: () => received.filter((m) => m.id !== undefined && (m.method === 'turn/start' || m.method === 'turn/steer')).length,
    beginTurn: async () => {
      const turn = turns.find((t) => !t.started && !t.ended);
      if (!turn) throw new Error('No accepted turn to start');
      turn.started = true;
      send({ method: 'turn/started', params: { threadId: fx.THREAD_ID, turn: turnOf(turn.id, 'inProgress') } });
    },
    endTurn: async (stopReason) => {
      const turn = running();
      if (!turn) throw new Error('No running turn');
      const status = STATUS[stopReason];
      if (!status) throw new Error(`No Codex turn status for ${stopReason}`);
      settle(turn, status);
    },
    requestPermission: async (requestId) => {
      void requestId;
      send({ ...fx.commandApprovalRequest, id: nextRequest++, params: { ...fx.commandApprovalRequest.params, turnId: running()?.id ?? fx.TURN_ID } });
    },
    resolvePermissionNatively: async (requestId) => {
      send({ method: 'serverRequest/resolved', params: { threadId: fx.THREAD_ID, requestId: Number(requestId) } });
    },
    ask: async () => {
      send({
        method: 'item/tool/requestUserInput',
        id: nextRequest++,
        params: {
          threadId: fx.THREAD_ID, turnId: running()?.id ?? fx.TURN_ID, itemId: 'q', isBlocking: true, autoResolutionMs: null,
          questions: [{ id: 'q1', header: '', question: 'Which?', isOther: true, isSecret: false, options: null }],
        },
      });
    },
    resolveQuestionNatively: async (requestId) => {
      send({ method: 'serverRequest/resolved', params: { threadId: fx.THREAD_ID, requestId: Number(requestId) } });
    },
    // The process goes away mid-turn without another word.
    disconnect: async () => {
      if (proc.exitCode !== null) return;
      proc.exitCode = 1;
      proc.emit('exit', 1, null);
    },
    failNextSend: () => { failNext = true; },
  };
  return { proc, control };
}

/** The Codex driver as a conformance subject; `spawn` is the test file's mocked child_process.spawn. */
export function codexConformanceSubject(spawn: { mockImplementation(fn: never): unknown }): ConformanceSubject {
  return {
    name: 'Codex app-server driver (scripted app-server)',
    traits: {
      mergesPrompts: true,
      steersRunningTurn: true,
      interruptReport: 'provider_reports',
      permissions: true,
      questions: true,
      nativeResolution: true,
      // On process exit the driver closes its open turn (turn_ended 'error') and requests
      // ('cancelled' by 'agent'). That is its own bookkeeping; app-server reported none of it.
      disconnectClosure: 'local_closure',
    },
    canFailSend: true,
    blocked: {
      disconnect_held_input_stays_unsent: 'the driver\'s turn_ended on process exit drains held input into the exited process (lifecycle-gaps.test.ts)',
    },
    create: async () => {
      const servers: Array<ReturnType<typeof createCodexAppServer>> = [];
      spawn.mockImplementation((() => {
        const server = createCodexAppServer();
        servers.push(server);
        return server.proc;
      }) as never);
      return {
        driver: new CodexChatDriver(),
        native: () => {
          const server = servers[servers.length - 1];
          if (!server) throw new Error('No app-server spawned');
          return server.control;
        },
      };
    },
  };
}
