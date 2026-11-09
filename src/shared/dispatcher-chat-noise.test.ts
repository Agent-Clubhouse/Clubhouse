import { describe, expect, it } from 'vitest';
import { cleanAgentNews, cleanChatText } from './dispatcher-chat-noise';

describe('cleanChatText', () => {
  it('drops routing tags and reply markers', () => {
    expect(cleanChatText('[TASK:t_abc123] [FROM:webapp-lead@webapp] Checkout is fixed.')).toBe('Checkout is fixed.');
    expect(cleanChatText('TASK_RESULT:t_lw3k2j9: Done, all tests pass.')).toBe('Done, all tests pass.');
    expect(cleanChatText('[HAND-OFF] Wake release-lead.')).toBe('Wake release-lead.');
    expect(cleanChatText('[Clubhouse] Update.')).toBe('Update.');
  });

  it('drops task ids in every spelling', () => {
    expect(cleanChatText('Sent it (task_id=t_lw3k2j9).')).toBe('Sent it.');
    expect(cleanChatText('Message sent. task_id: "t_99abc1" and done')).toBe('Message sent. and done');
    expect(cleanChatText('Handed off as handoff_lw3k2j9 just now.')).toBe('Handed off as just now.');
    expect(cleanChatText('requestId "r_17" is waiting')).toBe('is waiting');
  });

  it('keeps ordinary words that only look like ids', () => {
    expect(cleanChatText('The t_shirt order and the requestId field both work.')).toBe('The t_shirt order and the requestId field both work.');
  });

  it('drops reply instructions', () => {
    const text = 'Checkout is fixed.\n\n---\nReply to webapp-lead via tool "send_message" with task_id="t_1a2b3c". Prefix your response with TASK_RESULT:t_1a2b3c.';
    expect(cleanChatText(text)).toBe('Checkout is fixed.');
    expect(cleanChatText('All set.\nTo reply, call send_message with the agent id.')).toBe('All set.');
  });

  it('drops tool names', () => {
    expect(cleanChatText('I used mcp__clubhouse__send_message to ask it.')).toBe('I used to ask it.');
  });

  it('drops JSON, fenced or not, and keeps other code', () => {
    const fencedJson = 'Here it is:\n```json\n{"status":"running"}\n```\nAll good.';
    expect(cleanChatText(fencedJson)).toBe('Here it is:\n\nAll good.');
    const bare = 'Status:\n{\n  "agentId": "a1",\n  "status": "sleeping"\n}\nIt is asleep.';
    expect(cleanChatText(bare)).toBe('Status:\nIt is asleep.');
    const unlabelled = '```\n[1, 2, 3]\n```';
    expect(cleanChatText(unlabelled)).toBe('');
    const shell = 'Run this:\n```sh\nnpm test\n```';
    expect(cleanChatText(shell)).toBe(shell);
  });

  it('leaves plain text alone', () => {
    const text = 'Safari checkout is fixed in #412. All 41 tests pass now.';
    expect(cleanChatText(text)).toBe(text);
  });
});

describe('cleanAgentNews', () => {
  it('drops every code block, not only JSON', () => {
    expect(cleanAgentNews('Fixed it.\n```ts\nconst a = 1;\n```')).toBe('Fixed it.');
  });

  it('keeps every sentence of a raw agent report, without its noise (#3193)', () => {
    const raw = 'TASK_RESULT:t_lw3k2j9: Safari checkout is fixed in #412. All 41 tests pass now. I also refactored the cart module.\n'
      + '```json\n{"tests": 41}\n```\n---\nReply to Dispatcher via tool "send_message" with task_id="t_lw3k2j9".';
    expect(cleanAgentNews(raw)).toBe('Safari checkout is fixed in #412. All 41 tests pass now. I also refactored the cart module.');
  });

  it('is empty when only noise is left', () => {
    expect(cleanAgentNews('```json\n{"ok":true}\n```\ntask_id=t_abc123')).toBe('');
  });
});
