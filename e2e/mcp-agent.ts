/**
 * Acting as an agent in E2E, with no tokens spent. A fake CLI started by the
 * app reports the Clubhouse MCP bridge credentials it was given (its env), and
 * this client calls the bridge with them, so every call is a real tool call by
 * that agent: grants, Ask-first, and refusals all apply.
 *
 * - `connectMcp(env)`: a minimal MCP client as the agent the env belongs to.
 * - `raiseAskFirst(window, mcp, ...)`: a real permission request from that
 *   agent (`request_grant`), waiting on the person, and its request id, read
 *   from the app the agent runs in. Answer it through Needs you, the
 *   `agent.answerGrantRequest` API, or another computer's lead chat (#3354).
 */
import { expect, type Page } from '@playwright/test';

export type McpEnv = Record<string, string | null | undefined>;

export interface McpAgent {
  toolNames(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }>;
  callText(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
}

/** A minimal MCP client over the bridge, as the agent the credentials belong to. */
export async function connectMcp(env: McpEnv): Promise<McpAgent> {
  const url = `http://127.0.0.1:${env.CLUBHOUSE_MCP_PORT}/mcp/${env.CLUBHOUSE_AGENT_ID}`;
  let sessionId: string | null = null;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clubhouse-Nonce': env.CLUBHOUSE_HOOK_NONCE ?? '',
        ...(sessionId && { 'Mcp-Session-Id': sessionId }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    return (await res.json()).result;
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  const toolNames = async (): Promise<string[]> => (await rpc('tools/list')).tools.map((t: { name: string }) => t.name);
  const callText = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    return { isError: !!result.isError, text: result.content[0].text as string };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { isError, text } = await callText(name, args);
    return { isError, body: JSON.parse(text) };
  };
  return { toolNames, call, callText };
}

export interface AskFirstRequest {
  action: string;
  target: string;
  reason: string;
}

/**
 * A real permission request from the agent `mcp` acts as, waiting on the
 * person in `window`'s app. Resolves with its request id once that app lists it.
 */
export async function raiseAskFirst(page: Page, mcp: McpAgent, request: AskFirstRequest): Promise<string> {
  const before = new Set((await page.evaluate(() => window.clubhouse.agent.listGrantRequests())).map((r) => r.requestId));
  const asked = await mcp.callText('request_grant', { action: request.action, target: request.target, reason: request.reason });
  expect(asked.isError, asked.text).toBe(false);
  let requestId = '';
  await expect.poll(async () => {
    const now = await page.evaluate(() => window.clubhouse.agent.listGrantRequests());
    requestId = now.find((r) => !before.has(r.requestId))?.requestId ?? '';
    return requestId;
  }, { timeout: 15_000 }).not.toBe('');
  return requestId;
}

/** Whether `window`'s app still has the request waiting. */
export async function askFirstWaiting(page: Page, requestId: string): Promise<boolean> {
  return (await page.evaluate(() => window.clubhouse.agent.listGrantRequests())).some((r) => r.requestId === requestId);
}
