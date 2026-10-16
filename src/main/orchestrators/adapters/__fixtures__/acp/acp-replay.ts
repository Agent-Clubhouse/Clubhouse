/**
 * Test helper: replay a recorded ACP transcript against a mocked agent process.
 *
 * Each client write is matched against the next `out` record (same method, or
 * a response to the same agent request id). Once matched, the `in` records up
 * to the next `out` are delivered on stdout, with response ids rewritten to
 * the ids the client actually used. Mismatches are collected in `errors`
 * rather than thrown, so the client under test isn't disturbed mid-write.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AcpFixtureRecord {
  dir: 'in' | 'out';
  msg: Record<string, unknown>;
}

export interface MockAgentProcess {
  stdout: { emit(event: 'data', chunk: string): boolean };
  stdin: { write: (...args: unknown[]) => boolean };
}

export function loadAcpFixture(...segments: string[]): AcpFixtureRecord[] {
  const file = path.join(__dirname, ...segments);
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AcpFixtureRecord)
    .filter((r) => r.dir === 'in' || r.dir === 'out');
}

/**
 * Remove one client request (by method, first match), its response, and the
 * agent messages that followed it, so a test can skip a step the recording
 * took and the driver doesn't.
 */
export function withoutRequest(records: AcpFixtureRecord[], method: string): AcpFixtureRecord[] {
  const start = records.findIndex((r) => r.dir === 'out' && r.msg.method === method);
  if (start === -1) throw new Error(`fixture has no '${method}' request`);
  let end = start + 1;
  while (end < records.length && records[end].dir !== 'out') end++;
  return [...records.slice(0, start), ...records.slice(end)];
}

export type OutMatcher = (expected: Record<string, unknown>, actual: Record<string, unknown>) => string | null;

export class AcpFixtureReplayer {
  readonly errors: string[] = [];
  /** Every message the client wrote, parsed. */
  readonly written: Array<Record<string, unknown>> = [];
  private cursor = 0;
  private readonly idMap = new Map<unknown, unknown>();

  constructor(
    private readonly proc: MockAgentProcess,
    private readonly records: AcpFixtureRecord[],
    private readonly matchParams?: OutMatcher,
  ) {
    proc.stdin.write = (...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
      cb?.();
      for (const line of String(args[0]).split('\n')) {
        if (line.trim()) this.onClientMessage(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    };
    // Agents may speak first in some recordings.
    queueMicrotask(() => this.flush());
  }

  /** True once every record has been consumed or delivered. */
  get done(): boolean {
    return this.cursor >= this.records.length;
  }

  get remaining(): AcpFixtureRecord[] {
    return this.records.slice(this.cursor);
  }

  private onClientMessage(actual: Record<string, unknown>): void {
    this.written.push(actual);
    const next = this.records[this.cursor];
    if (!next || next.dir !== 'out') {
      this.errors.push(`unexpected client message ${describe(actual)}; fixture expected ${next ? describe(next.msg) + ' from the agent' : 'nothing more'}`);
      return;
    }
    const expected = next.msg;
    const problem = this.compare(expected, actual);
    if (problem) {
      this.errors.push(problem);
      return;
    }
    if (typeof expected.method === 'string' && expected.id !== undefined) {
      this.idMap.set(expected.id, actual.id);
    }
    this.cursor++;
    queueMicrotask(() => this.flush());
  }

  private compare(expected: Record<string, unknown>, actual: Record<string, unknown>): string | null {
    if (typeof expected.method === 'string') {
      if (actual.method !== expected.method) return `expected client to send ${describe(expected)}, got ${describe(actual)}`;
      if (('id' in expected) !== ('id' in actual)) return `${expected.method}: request/notification mismatch`;
    } else {
      if (actual.method !== undefined || actual.id !== expected.id) {
        return `expected client response to agent request ${String(expected.id)}, got ${describe(actual)}`;
      }
    }
    return this.matchParams?.(expected, actual) ?? null;
  }

  private flush(): void {
    while (this.cursor < this.records.length && this.records[this.cursor].dir === 'in') {
      const msg = { ...this.records[this.cursor].msg };
      this.cursor++;
      const isResponse = msg.method === undefined && msg.id !== undefined;
      if (isResponse && this.idMap.has(msg.id)) msg.id = this.idMap.get(msg.id);
      this.proc.stdout.emit('data', JSON.stringify(msg) + '\n');
    }
  }
}

function describe(msg: Record<string, unknown>): string {
  if (typeof msg.method === 'string') return `${msg.method}${msg.id !== undefined ? `#${String(msg.id)}` : ''}`;
  return `response#${String(msg.id)}`;
}
