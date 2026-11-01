/**
 * A local stand-in for the model APIs the CLIs call, so a real CLI can run a
 * full turn without a paid request. It speaks just enough of the Anthropic
 * Messages API (Claude Code), OpenAI Responses (Codex) and Chat Completions
 * (Copilot) to answer scripted turns, and records what each request offered.
 *
 * The user's prompt is the script:
 *   FAKE_CALL:<name part>:<tool suffix>[:<json args>]   call the offered tool whose name has both
 *   anything else                                       answer FAKE_DONE
 * A request whose last message carries a tool result is answered FAKE_DONE.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface FakeModelRequest {
  path: string;
  /** Tools offered in this request. */
  tools: string[];
  /** Text of the last user message. */
  prompt: string;
  /** Tool results in the last user message. */
  toolResults: string[];
  /** The full request body as text, for checking what history a CLI resent. */
  body: string;
  /** The tool the fake model called in its answer. */
  called?: string;
}

export interface FakeModelServer {
  url: string;
  requests: FakeModelRequest[];
  /** Paths nothing answers, so a run shows what else a CLI asked for. */
  unhandled: string[];
  close(): Promise<void>;
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

const SCRIPT_RE = /FAKE_CALL:([\w-]+):(\w+)(?::(\{[^\n]*\}))?/

function replyFor(tools: string[], prompt: string, toolResults: string[]): Reply {
  if (toolResults.length > 0) return { text: 'FAKE_DONE' };
  const m = SCRIPT_RE.exec(prompt);
  if (!m) return { text: 'FAKE_DONE' };
  const tool = tools.find((t) => t.includes(m[1]) && t.endsWith(`__${m[2]}`));
  if (!tool) return { text: `FAKE_NO_TOOL:${m[1]}:${m[2]}` };
  return { tool, args: m[3] ? JSON.parse(m[3]) : {} };
}

/** The items after the last one matching, which is what the model hasn't answered yet. */
function itemsAfterLast(items: any[], isLast: (item: any) => boolean): any[] {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isLast(items[i])) return items.slice(i + 1);
  }
  return items;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'tool_result' ? textOf(b.content) : '')).join('\n');
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function answerAnthropic(body: Record<string, any>, res: http.ServerResponse, request: FakeModelRequest): void {
  // Everything since the model last spoke: Claude Code can put reminders in a message of their own.
  const messages: any[] = body.messages ?? [];
  const blocks = itemsAfterLast(messages, (m) => m.role === 'assistant')
    .flatMap((m): any[] => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]));
  request.tools = (body.tools ?? []).map((t: { name: string }) => t.name);
  request.toolResults = blocks.filter((b) => b.type === 'tool_result').map((b) => textOf(b.content));
  request.prompt = textOf(blocks.filter((b) => b.type === 'text'));
  const reply = replyFor(request.tools, request.prompt, request.toolResults);
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const id = `msg_fake_${Math.random().toString(36).slice(2)}`;
  const toolUseId = `toolu_fake_${Math.random().toString(36).slice(2)}`;
  const content = 'tool' in reply
    ? [{ type: 'tool_use', id: toolUseId, name: reply.tool, input: reply.args }]
    : [{ type: 'text', text: reply.text }];
  const stopReason = 'tool' in reply ? 'tool_use' : 'end_turn';
  if ('tool' in reply) request.called = reply.tool;
  const message: Record<string, unknown> = { id, type: 'message', role: 'assistant', model: body.model, stop_sequence: null };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...message, content, stop_reason: stopReason, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage } });
  if ('tool' in reply) {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: reply.tool, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.args) } });
  } else {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function namespaced(namespace: string | undefined, name: string): string {
  return `${(namespace ?? '').replace(/_+$/, '')}__${name}`;
}

/** Tool names in a Responses or Chat Completions request, namespaces flattened. */
function openAiToolNames(tools: any[] | undefined): string[] {
  return (tools ?? []).flatMap((t): string[] => {
    if (Array.isArray(t.tools)) return openAiToolNames(t.tools).map((n) => namespaced(t.name, n));
    const name = t.function?.name ?? t.name;
    return typeof name === 'string' ? [name] : [];
  });
}

function usesNamespace(tools: any[] | undefined, full: string): { namespace: string; name: string } | undefined {
  for (const t of tools ?? []) {
    if (!Array.isArray(t.tools)) continue;
    const name = openAiToolNames(t.tools).find((n) => namespaced(t.name, n) === full);
    if (name) return { namespace: t.name, name };
  }
  return undefined;
}

function answerResponses(body: Record<string, any>, res: http.ServerResponse, request: FakeModelRequest): void {
  const input: any[] = Array.isArray(body.input) ? body.input : [];
  const since = itemsAfterLast(input, (i) => i.role === 'assistant');
  request.tools = openAiToolNames(body.tools);
  request.toolResults = since.filter((i) => i.type === 'function_call_output').map((i) => (typeof i.output === 'string' ? i.output : JSON.stringify(i.output)));
  request.prompt = since.filter((i) => i.role === 'user').flatMap((i) => i.content ?? []).map((c: any) => c.text ?? '').join('\n');
  const reply = replyFor(request.tools, request.prompt, request.toolResults);
  const id = `resp_fake_${Math.random().toString(36).slice(2)}`;
  let item: Record<string, unknown>;
  if ('tool' in reply) {
    request.called = reply.tool;
    const ns = usesNamespace(body.tools, reply.tool);
    item = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: ns?.name ?? reply.tool, ...(ns && { namespace: ns.namespace }), arguments: JSON.stringify(reply.args) };
  } else {
    item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] };
  }
  const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'response.created', { type: 'response.created', response: { id } });
  sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item });
  sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  sse(res, 'response.completed', { type: 'response.completed', response: { id, status: 'completed', output: [item], usage } });
  res.end();
}

function answerChatCompletions(body: Record<string, any>, res: http.ServerResponse, request: FakeModelRequest): void {
  const messages: any[] = body.messages ?? [];
  const since = itemsAfterLast(messages, (m) => m.role === 'assistant');
  request.tools = openAiToolNames(body.tools);
  request.toolResults = since.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
  request.prompt = since.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
  const reply = replyFor(request.tools, request.prompt, request.toolResults);
  const id = `chatcmpl_fake_${Math.random().toString(36).slice(2)}`;
  const chunk = (delta: unknown, finish: string | null, extra: object = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const usage = { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  if (!body.stream) {
    const message: Record<string, unknown> = 'tool' in reply
      ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${id}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
      : { role: 'assistant', content: reply.text };
    if ('tool' in reply) request.called = reply.tool;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }], ...usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if ('tool' in reply) {
    request.called = reply.tool;
    res.write(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, null));
    res.write(chunk({}, 'tool_calls', usage));
  } else {
    res.write(chunk({ role: 'assistant', content: reply.text }, null));
    res.write(chunk({}, 'stop', usage));
  }
  res.end('data: [DONE]\n\n');
}

export async function startFakeModelServer(): Promise<FakeModelServer> {
  const requests: FakeModelRequest[] = [];
  const unhandled: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '').split('?')[0];
      if (path.endsWith('/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (path.endsWith('/v1/messages') && req.method === 'POST') {
        const request: FakeModelRequest = { path, tools: [], prompt: '', toolResults: [], body: text };
        requests.push(request);
        answerAnthropic(JSON.parse(text), res, request);
        return;
      }
      if (req.method === 'POST' && (path.endsWith('/responses') || path.endsWith('/chat/completions'))) {
        const request: FakeModelRequest = { path, tools: [], prompt: '', toolResults: [], body: text };
        requests.push(request);
        (path.endsWith('/responses') ? answerResponses : answerChatCompletions)(JSON.parse(text), res, request);
        return;
      }
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [], models: [] }));
        return;
      }
      unhandled.push(`${req.method} ${path}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unhandled,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
