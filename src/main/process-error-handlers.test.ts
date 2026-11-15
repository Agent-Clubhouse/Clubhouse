import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogRedactor, redactActiveRunText } from '../shared/log-redaction';

vi.mock('./telemetry/crash-handlers', () => ({ reportMainProcessError: vi.fn() }));
vi.mock('./services/log-settings', () => ({
  getSettings: () => ({ enabled: true, namespaces: {}, minLogLevel: 'info' }),
}));

import { installProcessErrorHandlers } from './process-error-handlers';
import { reportMainProcessError } from './telemetry/crash-handlers';
import { markFailedCopilotWrites } from './chat/copilot/failed-writes';
import { _resetDiagForTests, setDiagSink, type DiagRecord } from './telemetry/diag';

let events: EventEmitter;
let uninstall: () => void;
let lines: DiagRecord[];
let runs: LogRedactor[];

function run(prompt?: string): LogRedactor {
  const redactor = new LogRedactor([], prompt ? [prompt] : []).startRun();
  runs.push(redactor);
  return redactor;
}

/** Throw a real error with the prompt in its message and a stack frame. */
function thrown(prompt: string): Error {
  try { throw new Error(`Provider failed with ${prompt}`); } catch (error) {
    const err = error as Error;
    err.stack += `\n    at provider (${prompt}:1:1)`;
    return err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  runs = [];
  lines = [];
  _resetDiagForTests('/test-home');
  setDiagSink({ writeDiag: (line) => lines.push(line), noteDiagDropped: vi.fn(), flush: async () => {} });
  events = new EventEmitter();
  uninstall = installProcessErrorHandlers(events as NodeJS.Process);
});

afterEach(() => {
  uninstall();
  for (const redactor of runs) redactor.endRun();
  _resetDiagForTests();
});

describe('process catch-all local diagnostics', () => {
  it.each(['uncaughtException', 'unhandledRejection'])('scrubs an active prompt from %s message and stack', (event) => {
    const prompt = 'PRIVATE-CATCHALL-PROMPT-1919';
    run(prompt);
    const error = thrown(prompt);
    expect(error.message).toContain(prompt);
    expect(error.stack).toContain(prompt);
    events.emit(event, error);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ns: 'core:process', level: event === 'uncaughtException' ? 'fatal' : 'error' });
    expect(lines[0].meta?.error).toContain('<redacted:');
    expect(lines[0].meta?.stack).toContain('<redacted:');
    expect(JSON.stringify(lines)).not.toContain(prompt);
    // Reporting remains unchanged; diagnostics alone receive the scrubbed view.
    expect(reportMainProcessError).toHaveBeenCalledWith(error, event === 'uncaughtException' ? 'uncaught' : 'unhandled-rejection');
    expect(error.message).toContain(prompt);
  });

  it('scrubs both concurrent runs, including prompts that contain another run\'s prompt', () => {
    const first = 'PRIVATE-FIRST-RUN-1919';
    const second = `${first} and PRIVATE-SECOND-RUN-1919`;
    const a = run();
    const b = run();
    // Late turns use the same registration and escaped/multiline learning as run-local logs.
    a.remember({ prompt: first });
    b.rememberText(second);
    events.emit('uncaughtException', thrown(`${first} / ${second}`));
    expect(JSON.stringify(lines)).not.toContain('PRIVATE');
    expect(lines[0].meta?.error).toContain('<redacted:');
  });

  it('forgets ended runs without accumulating past prompts or changing a concurrent run', () => {
    const active = 'ACTIVE-CATCHALL-PROMPT';
    run(active);
    const past: string[] = [];
    for (let i = 0; i < 100; i++) {
      const prompt = `ENDED-CATCHALL-PROMPT-${i}-END`;
      past.push(prompt);
      const redactor = run(prompt);
      expect(redactActiveRunText(prompt)).not.toContain(prompt);
      redactor.endRun();
      redactor.endRun(); // Disposal is idempotent.
      redactor.rememberText(`LATE-${prompt}`); // Late callbacks cannot re-register a dead run.
      expect(redactActiveRunText(prompt)).toBe(prompt);
    }
    expect(redactActiveRunText(past.join('\n'), Infinity)).toBe(past.join('\n'));
    expect(redactActiveRunText(active)).not.toContain(active);
  });

  it('scrubs full values before truncating the message and stack', () => {
    const prompt = 'PRIVATE-CUT-PROMPT-' + 'x'.repeat(2200);
    run(prompt);
    const error = new Error();
    error.message = 'd'.repeat(1950) + prompt + 'safe tail'.repeat(30);
    error.stack = 's'.repeat(1950) + prompt + 'safe frame'.repeat(30);
    events.emit('uncaughtException', error);
    for (const value of [lines[0].meta?.error, lines[0].meta?.stack]) {
      expect(value).not.toContain('PRIVATE');
      expect(value).not.toContain('x'.repeat(10));
      expect(value).toContain(`<redacted: ${prompt.length} chars>`);
      expect(value).toMatch(/…\[cut\]$/);
      expect(String(value).length).toBeLessThan(2020);
    }
  });

  it('preserves non-prompt diagnostics, the under-eight threshold and absent stacks', () => {
    run('short');
    events.emit('unhandledRejection', 'EACCES short diagnostic');
    expect(lines[0]).toMatchObject({ msg: 'Unhandled promise rejection', meta: { error: 'EACCES short diagnostic' } });
    expect(lines[0].meta?.stack).toBeUndefined();
    const error = new Error('spawn failed EPIPE');
    error.stack = 'Error: spawn failed EPIPE\n    at writer (provider.js:10:2)';
    events.emit('uncaughtException', error);
    expect(lines[1].meta).toEqual({ error: error.message, stack: error.stack });
  });

  it('scrubs marked Copilot write warnings while preserving their existing suppression', async () => {
    const prompt = 'PRIVATE-COPILOT-WRITE-1919';
    run(prompt);
    const error = thrown(prompt);
    const client = { messageWriter: { write: async () => { throw error; } } };
    markFailedCopilotWrites(client);
    await expect(client.messageWriter.write()).rejects.toBe(error);
    events.emit('unhandledRejection', error);
    expect(lines[0]).toMatchObject({ level: 'warn' });
    expect(JSON.stringify(lines)).not.toContain(prompt);
    expect(reportMainProcessError).not.toHaveBeenCalled();
  });

  it('removes both handlers on disposal', () => {
    uninstall();
    expect(events.listenerCount('uncaughtException')).toBe(0);
    expect(events.listenerCount('unhandledRejection')).toBe(0);
  });
});
