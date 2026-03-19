#!/usr/bin/env node
/**
 * Clubhouse MCP Bridge — standalone stdio↔HTTP relay.
 *
 * This script is spawned by agents as their MCP server. It reads JSON-RPC
 * messages from stdin (the agent) and relays them to the Clubhouse main
 * process via HTTP. SSE events from the main process are relayed back
 * to the agent on stdout.
 *
 * Environment variables:
 *   CLUBHOUSE_MCP_PORT   — bridge server port
 *   CLUBHOUSE_AGENT_ID   — agent identity
 *   CLUBHOUSE_HOOK_NONCE — auth token
 *
 * No external dependencies — uses only Node.js built-ins.
 */

const http = require('http');

const PORT = process.env.CLUBHOUSE_MCP_PORT;
const AGENT_ID = process.env.CLUBHOUSE_AGENT_ID;
const NONCE = process.env.CLUBHOUSE_HOOK_NONCE;

if (!PORT || !AGENT_ID || !NONCE) {
  process.stderr.write(
    'clubhouse-mcp-bridge: missing required env vars (CLUBHOUSE_MCP_PORT, CLUBHOUSE_AGENT_ID, CLUBHOUSE_HOOK_NONCE)\n',
  );
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}/mcp/${AGENT_ID}`;

// --- HTTP helpers ---

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, BASE_URL);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: parseInt(PORT, 10),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Clubhouse-Nonce': NONCE,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 && responseBody) {
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      },
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// --- SSE listener for tool list change notifications ---

let sseRetryCount = 0;
const SSE_MAX_RETRIES = 10;
const SSE_BASE_DELAY = 1000;
const SSE_MAX_DELAY = 30000;

function scheduleSSERetry() {
  if (sseRetryCount >= SSE_MAX_RETRIES) {
    process.stderr.write('clubhouse-mcp-bridge: max SSE reconnection attempts reached, giving up\n');
    return;
  }
  const delay = Math.min(SSE_BASE_DELAY * Math.pow(2, sseRetryCount), SSE_MAX_DELAY);
  sseRetryCount++;
  setTimeout(startSSE, delay);
}

function startSSE() {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: parseInt(PORT, 10),
      path: `/mcp/${AGENT_ID}/events`,
      method: 'GET',
      headers: {
        'X-Clubhouse-Nonce': NONCE,
        Accept: 'text/event-stream',
      },
    },
    (res) => {
      // Successful connection — reset retry counter
      sseRetryCount = 0;
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) {
              try {
                const notification = JSON.parse(data);
                if (notification.method) {
                  writeStdout(notification);
                }
              } catch {
                // Invalid JSON — skip
              }
            }
          }
        }
      });
      res.on('end', () => {
        // SSE connection closed — try to reconnect with backoff
        scheduleSSERetry();
      });
      res.on('error', () => {
        scheduleSSERetry();
      });
    },
  );

  req.on('error', () => {
    // Server not ready yet — retry with backoff
    scheduleSSERetry();
  });
  req.end();
}

// --- Stdio transport ---

function writeStdout(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

let inputBuffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split('\n');
  inputBuffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    handleMessage(line.trim());
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    process.stderr.write(`clubhouse-mcp-bridge: invalid JSON: ${raw}\n`);
    return;
  }

  // Notifications (no id) — fire and forget
  if (msg.id === undefined || msg.id === null) {
    await postJson(BASE_URL, msg).catch(() => {});
    return;
  }

  try {
    const response = await postJson(BASE_URL, msg);
    if (response) {
      writeStdout(response);
    } else {
      writeStdout({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Bridge server returned no response' },
      });
    }
  } catch (err) {
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: `Bridge error: ${err.message}` },
    });
  }
}

// Start SSE listener
startSSE();
