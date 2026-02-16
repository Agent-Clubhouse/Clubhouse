import * as http from 'http';
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getAgentProjectPath, getAgentOrchestrator, getAgentNonce, resolveOrchestrator } from './agent-system';
import { appLog } from './log-service';

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
    server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
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
          const raw = JSON.parse(body);
          const projectPath = getAgentProjectPath(agentId);
          const orchestrator = getAgentOrchestrator(agentId);

          if (projectPath) {
            // Validate nonce to reject events from external CLI instances
            const expectedNonce = getAgentNonce(agentId);
            const receivedNonce = req.headers['x-clubhouse-nonce'] as string | undefined;
            if (expectedNonce && receivedNonce !== expectedNonce) {
              appLog('core:hook-server', 'warn', 'Rejected hook event with invalid nonce', {
                meta: { agentId },
              });
              return;
            }

            const provider = resolveOrchestrator(projectPath, orchestrator);
            const normalized = provider.parseHookEvent(raw);

            if (normalized) {
              const toolVerb = normalized.toolName
                ? (provider.toolVerb(normalized.toolName) || `Using ${normalized.toolName}`)
                : undefined;

              const win = getMainWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send(IPC.AGENT.HOOK_EVENT, agentId, {
                  kind: normalized.kind,
                  toolName: normalized.toolName,
                  toolInput: normalized.toolInput,
                  message: normalized.message,
                  toolVerb,
                  timestamp: Date.now(),
                });
              }
            }
          }
        } catch (err) {
          appLog('core:hook-server', 'error', 'Failed to parse hook event', {
            meta: { agentId, error: err instanceof Error ? err.message : String(err) },
          });
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        appLog('core:hook-server', 'info', `Hook server listening on 127.0.0.1:${serverPort}`, {
          meta: { port: serverPort },
        });
        resolve(serverPort);
      } else {
        const err = new Error('Failed to get hook server address');
        appLog('core:hook-server', 'error', err.message);
        reject(err);
      }
    });

    server.on('error', (err: Error) => {
      appLog('core:hook-server', 'error', 'Hook server error', {
        meta: { error: err.message, stack: err.stack },
      });
      reject(err);
    });
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
