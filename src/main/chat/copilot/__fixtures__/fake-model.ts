/**
 * A local OpenAI-compatible model for driving a real Copilot runtime without
 * spending tokens, as scripts/probe-copilot-sdk.mjs does. Requests that offer
 * tools take the next scripted step; the CLI's own side calls just get "ok".
 */
import http from 'http';

export interface FakeModelStep {
  text?: string;
  tools?: Array<{ name: string; args?: unknown }>;
  /** Answer with this HTTP status instead of a completion. */
  status?: number;
  /** Wait for release() before finishing. */
  hold?: boolean;
}

export interface FakeModel {
  baseUrl: string;
  /** Every completion request, with the text of its messages. */
  requests: Array<{ model: string; effort?: string; text: string }>;
  /** The tool names offered by each request that offered any. */
  tools: string[][];
  script(...steps: FakeModelStep[]): void;
  /** A request is waiting on release(). */
  holding(): boolean;
  release(): void;
  /** Drop steps a test didn't use, and let go of anything held. */
  reset(): void;
  close(): void;
}

export async function startFakeModel(): Promise<FakeModel> {
  const requests: FakeModel['requests'] = [];
  const tools: string[][] = [];
  const queue: FakeModelStep[] = [];
  const held = new Set<() => void>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (!req.url?.includes('chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
      const json = JSON.parse(body) as { model: string; reasoning_effort?: string; tools?: Array<{ function?: { name?: string } }>; messages?: unknown };
      requests.push({ model: json.model, effort: json.reasoning_effort, text: JSON.stringify(json.messages ?? '') });
      if (json.tools?.length) tools.push(json.tools.map((t) => t.function?.name ?? ''));
      const step: FakeModelStep = json.tools?.length ? queue.shift() ?? {} : {};
      if (step.status) {
        res.statusCode = step.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `fake status ${step.status}`, type: 'invalid_request_error' } }));
        return;
      }
      const base = { id: `c${requests.length}`, created: 1, model: json.model, object: 'chat.completion.chunk' };
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish && { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      })}\n\n`;
      const calls = (step.tools ?? []).map((t, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
      const text = step.text ?? (calls.length ? '' : 'ok');
      res.setHeader('content-type', 'text/event-stream');
      if (text) res.write(chunk({ role: 'assistant', content: text }, null));
      if (calls.length) res.write(chunk({ role: 'assistant', tool_calls: calls }, null));
      if (step.hold) await new Promise<void>((r) => held.add(r));
      res.write(chunk({}, calls.length ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    tools,
    script: (...steps) => queue.push(...steps),
    holding: () => held.size > 0,
    release: () => { for (const r of held) r(); held.clear(); },
    reset: () => { queue.length = 0; for (const r of held) r(); held.clear(); },
    close: () => { for (const r of held) r(); server.closeAllConnections(); server.close(); },
  };
}
