/**
 * Entry for scripts/check-copilot-sdk-chunk.mjs: built through the production
 * main webpack config, then run with node against a `copilot` (the fake
 * server in CI, or a real install by hand) to prove the bundled SDK chunk
 * loads, spawns the given binary instead of its bundled runtime, and completes
 * the protocol handshake. No session is created and no prompt is sent.
 * Prints one JSON line with what it saw.
 */
import { loadCopilotSdk } from '../sdk-loader';

async function main(): Promise<void> {
  const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: process.argv[2] }),
    workingDirectory: process.cwd(),
  });
  await client.start();
  const status = await client.getStatus();
  await client.stop();
  process.stdout.write(JSON.stringify({ connected: true, status }) + '\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
    process.exit(1);
  },
);
