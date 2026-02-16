// @ts-nocheck
import * as http from 'http';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';

let server: any = null;
let serverPort = 0;
let readyPromise: Promise<number> | null = null;

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows[0] || null;
}

export function getPort(): number {
  return serverPort;
}

/** Wait for the server to be ready and return the port */
export function waitReady(): Promise<number> {
  if (serverPort > 0) return Promise.resolve(serverPort);
  if (readyPromise) return readyPromise;
  return Promise.reject(new Error('Hook server not started'));
}

export function start(): Promise<number> {
  readyPromise = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/hook/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const agentId = req.url.slice('/hook/'.length);
      if (!agentId) {
        res.writeHead(400);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200);
        res.end();

        try {
          const event = JSON.parse(body);
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, {
              eventName: event.hook_event_name || 'unknown',
              toolName: event.tool_name,
              toolInput: event.tool_input,
              notificationType: event.notification_type,
              message: event.message,
              timestamp: Date.now(),
            });
          }
        } catch {
          // Ignore malformed JSON
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        console.log(`Hook server listening on 127.0.0.1:${serverPort}`);
        resolve(serverPort);
      } else {
        reject(new Error('Failed to get hook server address'));
      }
    });

    server.on('error', reject);
  });

  return readyPromise;
}

export function stop(): void {
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
    readyPromise = null;
  }
}
