import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chatFixturePath,
  FAKE_CLI_SCRIPT,
  writeFakeCliShims,
  type ChatFixtureCli,
  type FakeCliReport,
} from '../src/main/orchestrators/adapters/testing/fake-cli';

/** The orchestrator each fake CLI stands in for. */
export const ORCHESTRATOR_FOR_CLI: Record<ChatFixtureCli, string> = {
  claude: 'claude-code',
  codex: 'codex-cli',
  copilot: 'copilot-cli',
};

/**
 * Fake `claude` / `codex` / `copilot` executables for chat E2E. Each replays
 * a committed fixture (test/chat-fixtures/<cli>/<name>.jsonl), so the app
 * talks to real protocol traffic and CI spends no tokens. Pass `env` to
 * `launchApp({ env })`: it pins each provider's binary to its fake (see
 * below) and puts the shims first on PATH.
 */
export interface FakeClis {
  env: Record<string, string>;
  /** Read the replay report for one CLI (complete, mismatch, argv, …). */
  report(cli: ChatFixtureCli): Promise<FakeCliReport>;
  cleanup(): Promise<void>;
}

/**
 * Windows: what npm writes for a CLI, so the app runs node on the script as it
 * does for a real install, without cmd.exe. A quick agent needs this: its system
 * prompt has a line break, which the app won't send through a plain batch file.
 */
async function writeNpmStyleShim(binDir: string, name: string, shim: { fixture: string; report: string }): Promise<string> {
  const script = `${name}-npm.mjs`;
  const fakeArgs = ['--fake-fixture', shim.fixture, '--fake-report', shim.report];
  await fs.promises.writeFile(path.join(binDir, script), [
    "import { pathToFileURL } from 'node:url';",
    `process.argv.splice(2, 0, ...${JSON.stringify(fakeArgs)});`,
    `await import(pathToFileURL(${JSON.stringify(FAKE_CLI_SCRIPT)}).href);`,
    '',
  ].join('\n'));
  const shimPath = path.join(binDir, `${name}-npm.cmd`);
  await fs.promises.writeFile(shimPath, `@echo off\r\nnode "%~dp0\\${script}" %*\r\n`);
  return shimPath;
}

/**
 * `fixtures` maps each CLI to a committed fixture's name, or to the absolute
 * path of one built at run time (e2e/chat-rich/harness.ts).
 */
export async function installFakeClis(
  fixtures: Partial<Record<ChatFixtureCli, string>>,
  { npmStyleShims = false }: { npmStyleShims?: boolean } = {},
): Promise<FakeClis> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-e2e-fake-cli-'));
  const binDir = path.join(root, 'bin');
  const reports: Partial<Record<ChatFixtureCli, string>> = {};
  const shims: Record<string, { fixture: string; report: string }> = {};
  for (const [cli, name] of Object.entries(fixtures) as Array<[ChatFixtureCli, string]>) {
    reports[cli] = path.join(root, `${cli}-report.json`);
    shims[cli] = { fixture: path.isAbsolute(name) ? name : chatFixturePath(cli, name), report: reports[cli] as string };
  }
  const written = await writeFakeCliShims(binDir, shims);
  if (npmStyleShims && process.platform === 'win32') {
    for (const [cli, shim] of Object.entries(shims)) written[cli] = await writeNpmStyleShim(binDir, cli, shim);
  }

  // Pin every provider's binary, not just the faked ones, through the
  // unpackaged-only CLUBHOUSE_TEST_CLI_BINARIES seam. The app's normal lookup
  // checks well-known install paths (/usr/local/bin, /opt/homebrew/bin, …)
  // before PATH, so on a machine with real CLIs a PATH shim alone could lose
  // and the test would spend tokens. A provider with no fixture points at a
  // path that doesn't exist, which the app reports as not installed.
  const binaries: Record<string, string> = {};
  for (const [cli, orchestrator] of Object.entries(ORCHESTRATOR_FOR_CLI) as Array<[ChatFixtureCli, string]>) {
    binaries[orchestrator] = written[cli] ?? path.join(root, 'not-installed', cli);
  }

  // PATH too, for anything that runs the CLI by name.
  // Windows spells it `Path`; overwrite that key rather than adding a second one.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    env: {
      CLUBHOUSE_TEST_CLI_BINARIES: JSON.stringify(binaries),
      // A model picker's live handshake would spawn the fake too and count in its report (#2569).
      CLUBHOUSE_TEST_NO_MODEL_PROBES: '1',
      // An agent card request (#3041) is a prompt the fake's script doesn't expect, and it would exit.
      CLUBHOUSE_TEST_NO_CARD_REQUESTS: '1',
      [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] ?? ''}`,
    },
    async report(cli) {
      const file = reports[cli];
      if (!file) throw new Error(`no fake ${cli} installed`);
      return JSON.parse(await fs.promises.readFile(file, 'utf8')) as FakeCliReport;
    },
    async cleanup() {
      // Windows: a fake that was just killed can hold its files for a moment.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}
