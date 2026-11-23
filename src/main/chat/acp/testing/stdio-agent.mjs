// A minimal ACP agent on stdio for transport tests. Hand-built from the public
// ACP v1 schema; not a recording of any real agent. No model, no network.
//   initialize -> protocol 1; session/new -> "stdio-1";
//   session/prompt "exit:<n>" exits with code n mid-turn; any other prompt
//   streams its text back in two chunks, split across writes, then end_turn.
import { createInterface } from 'node:readline';

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'stdio-agent', version: '0.0.0-test' } } });
  if (msg.method === 'session/new') return write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'stdio-1' } });
  if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((b) => b.text ?? '').join('');
    const exit = /^exit:(\d+)$/.exec(text);
    if (exit) process.exit(Number(exit[1]));
    const chunk = (t) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stdio-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
    const both = `${chunk(text.slice(0, 2))}\n${chunk(text.slice(2))}\n`;
    process.stdout.write(both.slice(0, 7));
    setTimeout(() => {
      process.stdout.write(both.slice(7));
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }, 5);
    return;
  }
  if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
