// Minimal stand-in for `copilot --headless --stdio`: answers the SDK's
// startup handshake over Content-Length framed JSON-RPC, and nothing else.
// Used by scripts/check-copilot-sdk-chunk.mjs; never sends a model request.
'use strict';

const PROTOCOL_VERSION = 3;
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(msg) {
  if (msg.id === undefined || typeof msg.method !== 'string') return;
  let result = {};
  if (msg.method === 'connect' || msg.method === 'ping') result = { protocolVersion: PROTOCOL_VERSION };
  if (msg.method === 'status.get') result = { version: 'fake', protocolVersion: PROTOCOL_VERSION, argv: process.argv.slice(2) };
  send({ jsonrpc: '2.0', id: msg.id, result });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) return;
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
