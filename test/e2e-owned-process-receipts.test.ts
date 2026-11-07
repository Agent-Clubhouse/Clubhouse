import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { observeOwnedProcess } from '../e2e/owned-process-receipts';

describe('owned process receipts without spawning', () => {
  it('records identity before setup, bounded stderr, and distinct exit/close events', () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 12345 });
    const stderr = new PassThrough();
    child.stderr = stderr;
    const records: Record<string, unknown>[] = [];
    const observer = observeOwnedProcess(() => child, row => records.push(row));
    expect(records[0]).toMatchObject({ phase: 'launch-returned', pid: 12345, exitObserved: false, closeObserved: false });
    stderr.emit('data', Buffer.from('x'.repeat(5000) + 'tail'));
    child.emit('exit', 7, null);
    expect(records[records.length - 1]).toMatchObject({ phase: 'exit', eventExitCode: 7, closeObserved: false });
    expect(String(records[records.length - 1]?.stderrTail)).toHaveLength(4096);
    child.emit('close', 7, null);
    expect(records[records.length - 1]).toMatchObject({ phase: 'close', exitObserved: true, closeObserved: true });
    expect(stderr.listenerCount('data')).toBe(0);
    observer.emit('setup-close-attempt', { outcome: 'fulfilled' });
    expect(records[records.length - 1]).toMatchObject({ outcome: 'fulfilled', closeObserved: true });
    stderr.destroy();
  });

  it('contains observer failures including undefined without claiming known accounting', () => {
    const records: Record<string, unknown>[] = [];
    expect(() => observeOwnedProcess(() => { throw undefined; }, row => records.push(row))).not.toThrow();
    expect(records[0]).toMatchObject({ pid: null, accountingKnown: false, closeObserved: false });
    const child = new ChildProcess();
    const observer = observeOwnedProcess(() => child, () => { throw undefined; });
    expect(() => { child.emit('exit', 0, null); child.emit('close', 0, null); observer.emit('setup-failed'); }).not.toThrow();
  });

  it('reports already-exited status without retroactively claiming an observed close', () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'exitCode', { value: 1 });
    const records: Record<string, unknown>[] = [];
    observeOwnedProcess(() => child, row => records.push(row));
    expect(records[0]).toMatchObject({ exitCode: 1, exitObserved: false, closeObserved: false });
    child.emit('close', 1, null);
  });
});
