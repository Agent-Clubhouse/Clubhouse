/**
 * Test helpers for the fake Antigravity CLI (scripts/chat-fixtures/fake-agy.mjs).
 * Its shapes are hand-built from Google's public docs and the ACP v1 schema,
 * not recorded from a real `agy` (#3788). Nothing here spends tokens, needs an
 * account or touches the user's ~/.gemini.
 *
 * Test-only: production code must not import this module.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** The fake. Run it with `process.execPath`. */
export const FAKE_AGY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'chat-fixtures', 'fake-agy.mjs');

/** Orchestrator id the shim is registered under in `CLUBHOUSE_TEST_CLI_BINARIES`. */
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-cli';

export type FakeAgyPersonality = 'version' | 'models' | 'agents' | 'acp' | 'headless' | 'tui';
export type FakeAgySteer = 'both-end' | 'join-first-ends' | 'second-rejected';

/** A prompt-script step; see BUILTIN_SCRIPTS in fake-agy.mjs. */
export type FakeAgyStep =
  | { chunk: string }
  | { update: Record<string, unknown> }
  | { permission: Record<string, unknown>; options?: Array<{ optionId: string; name: string; kind: string }>; outcomes: Record<string, FakeAgyStep[]> }
  | { question: { message: string; requestedSchema: Record<string, unknown> } }
  | { hold: true }
  | { end: string }
  | { error: { code: number; message: string } }
  | { exit: number };

/** Overrides for the fake's DEFAULTS. Every section is optional and merged one level deep. */
export interface FakeAgyConfig {
  version?: string;
  versionOutput?: string | null;
  models?: Array<[slug: string, name: string]>;
  agents?: string[];
  acp?: {
    supported?: boolean;
    protocolVersion?: number;
    auth?: 'ok' | 'required';
    authenticate?: 'refuse' | 'succeed';
    configOptionIds?: { model?: string; thoughtLevel?: string };
    currentModel?: string | null;
    currentThoughtLevel?: string;
    autoMode?: boolean;
    availableCommands?: Array<{ name: string; description: string; input?: unknown }>;
    steer?: FakeAgySteer;
    sessions?: Array<{ sessionId: string; cwd?: string | null; title?: string | null; updatedAt?: string; history?: Array<Record<string, unknown>> }>;
    scripts?: Record<string, FakeAgyStep[]>;
  };
  headless?: {
    scenario?: 'success' | 'tool' | 'soft-deny' | 'error' | 'auth-required';
    response?: string;
    authRequiredExitCode?: number;
  };
  tui?: {
    banner?: 'stderr' | 'stdout' | 'none';
    tool?: { name: string; args: Record<string, unknown> } | null;
    stopContinueLimit?: number;
  };
  hooks?: {
    onFailure?: 'allow' | 'deny';
    env?: 'inherit' | 'minimal';
    maxTimeoutMs?: number;
  };
}

export interface FakeAgyHookRun {
  event: string | null;
  name: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  jsonOutput?: boolean;
  decision?: string | null;
  failed?: boolean;
  error?: string;
}

/** What the fake writes after every step of a session personality (`acp`, `headless`, `tui`). */
export interface FakeAgyReport {
  fake: 'fake-agy';
  /** Always `document-derived`: never a recording. */
  source: 'document-derived';
  /** Shapes the docs don't give, which the fake made up. */
  synthesized: string[];
  pid: number;
  personality: FakeAgyPersonality;
  argv: string[];
  cwd: string;
  /** CLUBHOUSE_AGENT_ID, CLUBHOUSE_MCP_PORT, AGY_CLI_DISABLE_AUTO_UPDATE as launched (null if unset). */
  env: Record<string, string | null>;
  /** Whether a hook nonce was in the environment. Its value is never recorded. */
  hookNoncePresent: boolean;
  /** Names of credential variables that were set. Values are never recorded. */
  credentialKeysPresent: string[];
  acp: null | {
    initialized: { protocolVersion: unknown; clientInfo: unknown; clientCapabilities: unknown } | null;
    /** Client requests and notifications; MCP servers reduced to names and key names. */
    received: Array<{ method: string; id?: unknown; params: unknown }>;
    clientResponses: Array<{ id: unknown; method: string | null; result: unknown; error: unknown }>;
    /** Answers to requests the fake had already abandoned (cancel) or never sent. */
    late: Array<{ id: unknown; method: string | null; result: unknown; error: unknown }>;
    authenticateCalls: number;
    autoApproved: string[];
    steers: Array<{ sessionId: string; text: string; variant: FakeAgySteer }>;
    cancels: number;
  };
  headless: null | { format: string; inputFormat: string; scenario: string; model: string | null; prompts: string[]; softDenied: string[] };
  tui: null | { inputs: string[]; toolDecisions: Array<{ tool: string; decision: string | undefined }> };
  hooks: FakeAgyHookRun[];
  exitCode: number | null;
}

export interface FakeAgy {
  /** Spawn target: the current Node binary. */
  binary: string;
  /** Script path, fake options, then `cliArgs`. */
  args: string[];
  configPath: string;
  reportPath: string;
  /** The report of the latest run of `personality` (default: any), polled until it exists. */
  readReport(personality?: FakeAgyPersonality, timeoutMs?: number): Promise<FakeAgyReport>;
  waitForReport(predicate: (report: FakeAgyReport) => boolean, personality?: FakeAgyPersonality, timeoutMs?: number): Promise<FakeAgyReport>;
  /** An `agy` executable (`agy.cmd` on Windows) in this fake's folder, for CLUBHOUSE_TEST_CLI_BINARIES or PATH. */
  shim(): Promise<string>;
  dispose(): Promise<void>;
}

/** Prepare a fake `agy` with `config` over the defaults. */
export async function createFakeAgy(config: FakeAgyConfig = {}, opts: { cliArgs?: string[] } = {}): Promise<FakeAgy> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-fake-agy-'));
  const configPath = path.join(dir, 'config.json');
  const reportPath = path.join(dir, 'report.json');
  await fs.promises.writeFile(configPath, JSON.stringify(config));
  const fakeArgs = ['--fake-agy-config', configPath, '--fake-agy-report', reportPath];

  const fileFor = (personality?: FakeAgyPersonality) => (personality ? `${reportPath}.${personality}.json` : reportPath);
  const waitForReport = async (predicate: (r: FakeAgyReport) => boolean, personality?: FakeAgyPersonality, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let last: FakeAgyReport | undefined;
    let lastError: unknown;
    for (;;) {
      try {
        last = JSON.parse(await fs.promises.readFile(fileFor(personality), 'utf8')) as FakeAgyReport;
        if (predicate(last)) return last;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() > deadline) {
        throw new Error(`fake agy report did not reach the expected state: ${last ? JSON.stringify(last) : String(lastError)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  let shimPath: string | undefined;
  return {
    binary: process.execPath,
    args: [FAKE_AGY_SCRIPT, ...fakeArgs, ...(opts.cliArgs ?? [])],
    configPath,
    reportPath,
    readReport: (personality, timeoutMs) => waitForReport(() => true, personality, timeoutMs),
    waitForReport,
    async shim() {
      shimPath ??= await writeFakeAgyShim(path.join(dir, 'bin'), { configPath, reportPath });
      return shimPath;
    },
    async dispose() {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * Write an executable named `agy` into `dir` that runs the fake. Windows gets
 * `agy.cmd`, which also takes the batch-shim spawn route. Returns its path.
 */
export async function writeFakeAgyShim(dir: string, opts: { configPath?: string; reportPath?: string } = {}): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const fakeArgs = [
    FAKE_AGY_SCRIPT,
    ...(opts.configPath ? ['--fake-agy-config', opts.configPath] : []),
    ...(opts.reportPath ? ['--fake-agy-report', opts.reportPath] : []),
  ];
  if (process.platform === 'win32') {
    const shimPath = path.join(dir, 'agy.cmd');
    const quoted = [process.execPath, ...fakeArgs].map((a) => `"${a}"`).join(' ');
    await fs.promises.writeFile(shimPath, `@echo off\r\n${quoted} %*\r\n`);
    return shimPath;
  }
  const shimPath = path.join(dir, 'agy');
  const quoted = [process.execPath, ...fakeArgs].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  await fs.promises.writeFile(shimPath, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  return shimPath;
}

/** The `CLUBHOUSE_TEST_CLI_BINARIES` value that points Antigravity at `shimPath`, merged into `existing`. */
export function fakeAgyTestBinaries(shimPath: string, existing?: string): string {
  const map = existing ? (JSON.parse(existing) as Record<string, string>) : {};
  return JSON.stringify({ ...map, [ANTIGRAVITY_PROVIDER_ID]: shimPath });
}
