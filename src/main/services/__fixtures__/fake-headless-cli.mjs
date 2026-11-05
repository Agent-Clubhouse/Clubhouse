// A stand-in for an agent CLI, for headless-manager.fake-cli.test.ts. It spends
// no tokens and proves how the app responds, not what a real CLI does.
//
//   node fake-headless-cli.mjs <mode> <file for the holder's pid>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [mode, holderPidFile] = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const claudeRun = () => {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } });
  emit({ type: 'result', result: 'all done', duration_ms: 5 });
};

// The vocabulary of Copilot's session events, from the recorded fixtures in
// test/chat-fixtures/copilot-sdk and ~/.copilot/session-state. No recording of
// `copilot -p --output-format json` exists, so its use on stdout is an assumption.
const copilotRun = () => {
  emit({ type: 'session.start', data: { sessionId: 's1' } });
  emit({ type: 'assistant.turn_start', data: { turnId: '0' } });
  emit({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'edit', arguments: { path: 'a.ts' } } });
  emit({ type: 'tool.execution_complete', data: { toolCallId: 't1', success: true } });
  emit({ type: 'assistant.message', data: { messageId: 'm1', content: 'all done', toolRequests: [] } });
  emit({ type: 'assistant.turn_end', data: { turnId: '0' } });
  emit({ type: 'session.shutdown', data: { shutdownType: 'routine' } });
};

/** A child that outlives this process and keeps its stdout and stderr open, as an MCP server might. */
const holdStdout = () => {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  holder.unref();
  writeFileSync(holderPidFile, String(holder.pid));
};

const stayAlive = () => setInterval(() => {}, 60_000);

switch (mode) {
  case 'exit':
    claudeRun();
    break;
  case 'copilot-exit':
    copilotRun();
    break;
  case 'result-then-linger':
    claudeRun();
    stayAlive();
    break;
  case 'exit-child-holds-stdout':
    claudeRun();
    holdStdout();
    break;
  case 'linger-child-holds-stdout':
    claudeRun();
    holdStdout();
    stayAlive();
    break;
  case 'ignore-sigterm-child-holds-stdout':
    process.on('SIGTERM', () => {});
    claudeRun();
    holdStdout();
    stayAlive();
    break;
  default:
    process.exit(64);
}
