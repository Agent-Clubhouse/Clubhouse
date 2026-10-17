/**
 * Entry for scripts/check-claude-sdk-chunk.mjs: built through the production
 * main webpack config, then run with node against fake-claude.mjs to prove the
 * bundled Agent SDK chunk loads and drives an external `claude`.
 * Prints one JSON line with the event kinds it saw.
 */
import { ClaudeSdkTransport } from '../sdk-transport';

async function main(): Promise<void> {
  const transport = new ClaudeSdkTransport({ binary: process.argv[2], cwd: process.cwd(), permissionMode: 'default' });
  const kinds: string[] = [];
  const done = (async () => {
    for await (const ev of transport.events) kinds.push(ev.kind);
  })();
  await transport.start();
  transport.send({ text: 'hello' });
  const deadline = Date.now() + 20_000;
  while (!kinds.includes('turn_ended') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await transport.close();
  await done;
  process.stdout.write(JSON.stringify({ kinds }) + '\n');
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
    process.exit(1);
  },
);
