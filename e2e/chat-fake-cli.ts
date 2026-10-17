import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chatFixturePath,
  writeFakeCliShims,
  type ChatFixtureCli,
  type FakeCliReport,
} from '../src/main/orchestrators/adapters/testing/fake-cli';

/**
 * Fake `claude` / `codex` / `copilot` executables for chat E2E. Each replays
 * a committed fixture (test/chat-fixtures/<cli>/<name>.jsonl), so the app
 * talks to real protocol traffic and CI spends no tokens. Pass `env` to
 * `launchApp({ env })`; it puts the shims first on PATH.
 */
export interface FakeClis {
  env: Record<string, string>;
  /** Read the replay report for one CLI (complete, mismatch, argv, …). */
  report(cli: ChatFixtureCli): Promise<FakeCliReport>;
  cleanup(): Promise<void>;
}

export async function installFakeClis(fixtures: Partial<Record<ChatFixtureCli, string>>): Promise<FakeClis> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-e2e-fake-cli-'));
  const binDir = path.join(root, 'bin');
  const reports: Partial<Record<ChatFixtureCli, string>> = {};
  const shims: Record<string, { fixture: string; report: string }> = {};
  for (const [cli, name] of Object.entries(fixtures) as Array<[ChatFixtureCli, string]>) {
    reports[cli] = path.join(root, `${cli}-report.json`);
    shims[cli] = { fixture: chatFixturePath(cli, name), report: reports[cli] as string };
  }
  await writeFakeCliShims(binDir, shims);

  // Windows spells it `Path`; overwrite that key rather than adding a second one.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    env: { [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] ?? ''}` },
    async report(cli) {
      const file = reports[cli];
      if (!file) throw new Error(`no fake ${cli} installed`);
      return JSON.parse(await fs.promises.readFile(file, 'utf8')) as FakeCliReport;
    },
    async cleanup() {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}
