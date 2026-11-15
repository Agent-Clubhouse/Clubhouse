import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
vi.mock('child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'child_process';
import { LogRedactor } from '../../../shared/log-redaction';
import { launchCopilotServer } from './launch';

describe('Copilot diagnostic stderr tail', () => {
  it('scrubs later turns and split echoes before any tail truncation, retaining raw UI stderr (#1919 QA)', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kill: vi.fn(), pid: 123 });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const logRedactor = new LogRedactor();
    const opened = launchCopilotServer({ binary: 'fake', timeoutMs: 3000, logRedactor });
    child.stdout.emit('data', Buffer.from('listening on port 1234'));
    const server = await opened;
    const prompt = 'PRIVATE-COPILOT-LATE-TURN-1919-' + 'x'.repeat(4200);
    logRedactor.rememberText(prompt);
    child.stderr.emit('data', Buffer.from('warning: ' + prompt.slice(0, 25)));
    expect(server.stderrTailForLog!()).toBe('warning:');
    child.stderr.emit('data', Buffer.from(prompt.slice(25)));
    child.emit('close', 1);
    expect(server.stderrTailForLog!()).toBe(`warning: <redacted: ${prompt.length} chars>`);
    expect(server.stderrTail()).toContain('x'.repeat(100));
    expect(server.stderrTailForLog!()).not.toContain('x'.repeat(100));
    await server.exited;
  });
});
