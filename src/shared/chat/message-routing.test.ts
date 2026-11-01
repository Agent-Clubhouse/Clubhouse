import { describe, expect, it } from 'vitest';
import { coalesceUpdateTexts } from './coalesce';
import { messageDisplay, messageSummary, parseRoutedText, stripTaskMarker } from './message-routing';

const REPLY = '\n\n---\nReply to rover via tool "clubhouse__x__send_message" with task_id="t_1". Prefix your response with TASK_RESULT:t_1.';
const MISSION = '\n\n---\nYou are a helper agent started by boss. Use the message_parent tool to send boss your progress, questions and results.';

describe('parseRoutedText', () => {
  it('reads a send_message with its reply footer', () => {
    expect(parseRoutedText(`[TASK:t_1] [FROM:rover@Clubhouse] Hello there.${REPLY}`)).toEqual([
      { sender: { name: 'rover' }, text: 'Hello there.' },
    ]);
  });

  it('reads a one-way send_message and a name with no project', () => {
    expect(parseRoutedText('[TASK:t_1] [FROM:Dispatcher] Hi')).toEqual([{ sender: { name: 'Dispatcher' }, text: 'Hi' }]);
  });

  it('reads message_parent with the helper id', () => {
    expect(parseRoutedText('[FROM HELPER:typecheck-leak (durable_1)] All\ngreen.')).toEqual([
      { sender: { agentId: 'durable_1', name: 'typecheck-leak' }, text: 'All\ngreen.' },
    ]);
  });

  it('reads a helper question without its answer instructions', () => {
    const text = '[QUESTION FROM HELPER:h (durable_2)] h is waiting for your answer. Answer with answer_helper_question, requestId "hq_1". If the user should decide, call it with escalate: true instead.\n1. Which one?';
    expect(parseRoutedText(text)).toEqual([{ sender: { agentId: 'durable_2', name: 'h' }, text: '1. Which one?' }]);
  });

  it('reads a helper mission, with or without the waker\'s message after it', () => {
    expect(parseRoutedText(`[FROM:boss] Do it${MISSION}`)).toEqual([{ sender: { name: 'boss' }, text: 'Do it' }]);
    expect(parseRoutedText(`[FROM:boss] Do it${MISSION}\n\n[FROM:boss] And this`)).toEqual([
      { sender: { name: 'boss' }, text: 'Do it\n\nAnd this' },
    ]);
  });

  it('reads a file notice as just the delivery', () => {
    expect(parseRoutedText('[TASK:t_1] [FROM:rover@p] File delivered: /tmp/a.md — read this file for content from rover@p.')).toEqual([
      { sender: { name: 'rover' }, text: 'File delivered: /tmp/a.md' },
    ]);
  });

  it('reads a Clubhouse notice', () => {
    expect(parseRoutedText('[Clubhouse] Helper ready.')).toEqual([{ fromClubhouse: true, text: 'Helper ready.' }]);
  });

  it('splits a coalesced burst into its messages, in order', () => {
    const text = coalesceUpdateTexts(['[FROM HELPER:a (1)] one', '[Clubhouse] two', '[FROM HELPER:b (2)] three\n\nmore']);
    expect(parseRoutedText(text)).toEqual([
      { sender: { agentId: '1', name: 'a' }, text: 'one' },
      { fromClubhouse: true, text: 'two' },
      { sender: { agentId: '2', name: 'b' }, text: 'three\n\nmore' },
    ]);
  });

  it('leaves untagged text whole, and tags in the middle of a message alone', () => {
    expect(parseRoutedText('Just text about [FROM:x] tags')).toEqual([{ text: 'Just text about [FROM:x] tags' }]);
  });

  it('leaves text alone when it only looks like a burst', () => {
    const text = '3 updates, oldest first:\n\nnot really';
    expect(parseRoutedText(text)).toEqual([{ text }]);
  });
});

describe('stripTaskMarker', () => {
  it('drops a leading reply marker', () => {
    expect(stripTaskMarker('TASK_RESULT:t_1: done')).toBe('done');
    expect(stripTaskMarker('TASK_RESULT:t_1 done')).toBe('done');
    expect(stripTaskMarker('TASK_ACK:t_1: on it')).toBe('on it');
  });

  it('keeps a marker that is talked about', () => {
    expect(stripTaskMarker('I printed TASK_RESULT:t_1 above')).toBe('I printed TASK_RESULT:t_1 above');
  });
});

describe('messageDisplay', () => {
  it('never parses what the user typed', () => {
    expect(messageDisplay({ source: 'user', text: '[FROM:boss] hi' })).toEqual({ from: 'you', text: '[FROM:boss] hi' });
    expect(messageDisplay({ source: 'annex', text: '[Clubhouse] hi' })).toEqual({ from: 'you', text: '[Clubhouse] hi' });
  });

  it('prefers structured data over the text', () => {
    const routed = [{ sender: { agentId: 'durable_1', name: 'real' }, text: '[FROM:fake] hi' }];
    expect(messageDisplay({ source: 'mcp', text: '[FROM:real] [FROM:fake] hi', routed })).toEqual({ from: 'others', parts: routed });
  });

  it('strips a leading reply marker from any sender', () => {
    expect(messageDisplay({ source: 'mcp', text: '[TASK:t_2] [FROM:a@p] TASK_RESULT:t_1: done' })).toEqual({
      from: 'others', parts: [{ sender: { name: 'a' }, text: 'done' }],
    });
    expect(messageDisplay({ source: 'mcp', text: 'raw', routed: [{ sender: { name: 'a' }, text: 'TASK_RESULT:t_1: done' }] })).toEqual({
      from: 'others', parts: [{ sender: { name: 'a' }, text: 'done' }],
    });
  });

  it('treats a mission without a tag as the user\'s, and with one as the sender\'s', () => {
    expect(messageDisplay({ source: 'mission', text: 'Fix it' })).toEqual({ from: 'you', text: 'Fix it' });
    expect(messageDisplay({ source: 'mission', text: `[FROM:boss] Fix it${MISSION}` })).toEqual({
      from: 'others', parts: [{ sender: { name: 'boss' }, text: 'Fix it' }],
    });
  });

  it('keeps an old untagged MCP message on the left with no sender', () => {
    expect(messageDisplay({ source: 'mcp', text: 'hello' })).toEqual({ from: 'others', parts: [{ text: 'hello' }] });
  });

  it('marks system text as Clubhouse\'s and group project text as neither', () => {
    expect(messageDisplay({ source: 'system', text: 'Continued' })).toEqual({ from: 'others', parts: [{ fromClubhouse: true, text: 'Continued' }] });
    expect(messageDisplay({ source: 'group_project', text: 'Nudge' })).toEqual({ from: 'others', parts: [{ text: 'Nudge' }] });
  });

  const tap = (from: string) => `Group Project notification — shoulder tap from "${from}" in "Proj"\nLook here\n\n---\nRESPONSE INSTRUCTIONS:\nProject: "Proj" (ID: 1)\nTask ID: tap_1`;

  it('reads a shoulder tap from an agent, and from the UI as the user\'s own', () => {
    expect(messageDisplay({ source: 'shoulder_tap', text: tap('rover@Proj') })).toEqual({
      from: 'others', parts: [{ sender: { name: 'rover' }, text: 'Look here' }],
    });
    expect(messageDisplay({ source: 'shoulder_tap', text: tap('user') })).toEqual({ from: 'you', text: 'Look here' });
  });
});

describe('messageSummary', () => {
  it('names each sender on one line', () => {
    const text = coalesceUpdateTexts(['[FROM HELPER:a (1)] one', '[Clubhouse] two']);
    expect(messageSummary({ source: 'mcp', text })).toBe('a: one · Clubhouse: two');
  });

  it('leaves the user\'s message as typed', () => {
    expect(messageSummary({ source: 'user', text: 'mine' })).toBe('mine');
  });
});
