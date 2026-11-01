/**
 * Entry for scripts/check-copilot-sdk-chunk.mjs: built through the production
 * main webpack config, then run against the runtime given in argv to prove the
 * bundled SDK chunk loads and completes a handshake on this platform.
 * It never calls `send`, so no model request is possible.
 * Prints one JSON line with what the runtime reported.
 */
import { loadCopilotSdk } from '../sdk-loader';

async function main(): Promise<void> {
  const { CopilotClient, RuntimeConnection, approveAll } = await loadCopilotSdk();
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: process.argv[2] }),
    useLoggedInUser: false,
    logLevel: 'error',
  });
  await client.start();
  const status = await client.getStatus();
  const auth = await client.getAuthStatus();
  const session = await client.createSession({ onPermissionRequest: approveAll });
  const { sessionId } = session;
  await session.disconnect();
  await client.stop();
  process.stdout.write(JSON.stringify({
    version: status.version,
    protocolVersion: status.protocolVersion,
    authenticated: auth.isAuthenticated,
    sessionId,
    electron: process.versions.electron ?? null,
  }) + '\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
    process.exit(1);
  },
);
