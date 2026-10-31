import { describe, it, expect } from 'vitest';
import type { ChatEvent } from '../../shared/chat';
import { MOBILE_SLASH_COMMANDS_MAX, latestSlashCommands, remoteChatEvent, remoteSlashCommands } from './annex-chat-echo';

const base = { v: 1, agentId: 'a', sessionId: 's', seq: 3, ts: 1 } as const;
const userMessage = (content: unknown[]): ChatEvent => ({ ...base, type: 'user_message', data: { messageId: 'm', clientCommandId: 'c', source: 'annex', delivery: 'prompt', content } } as unknown as ChatEvent);

describe('remoteChatEvent (#2453)', () => {
  it('turns user images into mediaRefs and never sends absolute paths or inline bytes', () => {
    const ref = `${'ab'.repeat(32)}.png`;
    const event = userMessage([
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', path: '/Users/me/Library/Application Support/Clubhouse/chat-attachments/a/x.png', mediaRef: ref, width: 4, height: 5 },
      { type: 'image', mimeType: 'image/jpeg', path: 'C:\\Users\\me\\AppData\\pasted.jpg', data: 'QUJD' },
      { type: 'image', mimeType: 'image/png', uri: 'data:image/png;base64,QUJD' },
      { type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' },
      { type: 'file', path: '/Users/me/project/notes.txt' },
    ]);
    const out = remoteChatEvent(event);
    expect(out).toEqual({ ...event, data: { ...(event as Extract<ChatEvent, { type: 'user_message' }>).data, content: [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', mediaRef: ref, width: 4, height: 5, path: 'x.png' },
      { type: 'image', mimeType: 'image/jpeg', path: 'pasted.jpg' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'image', mimeType: 'image/png', uri: 'https://example.com/a.png' },
      { type: 'file', path: 'notes.txt' },
    ] } });
    const wire = JSON.stringify(out);
    expect(wire).not.toMatch(/\/Users|C:\\\\|QUJD|chat-attachments/);
  });

  it('passes other events, and text-only messages, through untouched', () => {
    const text = userMessage([{ type: 'text', text: 'hi' }]);
    expect(remoteChatEvent(text)).toBe(text);
    const other = { ...base, type: 'agent_message', data: { messageId: 'm', text: '/Users/me' } } as unknown as ChatEvent;
    expect(remoteChatEvent(other)).toBe(other);
  });
});

describe('slash commands for phones', () => {
  const commands = (list: unknown[]): ChatEvent => ({ ...base, type: 'commands_available', data: { commands: list } } as unknown as ChatEvent);

  it('keeps name, short description, hint and startOnly; drops names that would not run', () => {
    expect(remoteSlashCommands([
      { name: 'compact', description: 'Compact\n  the context', startOnly: true },
      { name: 'review', inputHint: '<pr>', startOnly: false },
      { name: 'skill', description: 'x'.repeat(400), inputHint: '   ' },
      { name: '' }, { name: 'two words' }, { name: 'n'.repeat(65) },
      { name: 'extra', description: 'd', source: 'project', path: '/Users/me/.claude/commands/extra.md' } as never,
    ])).toEqual([
      { name: 'compact', description: 'Compact the context', startOnly: true },
      { name: 'review', inputHint: '<pr>' },
      { name: 'skill', description: `${'x'.repeat(159)}…` },
      { name: 'extra', description: 'd' },
    ]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MOBILE_SLASH_COMMANDS_MAX + 5 }, (_, i) => ({ name: `c${i}` }));
    expect(remoteSlashCommands(many)).toHaveLength(MOBILE_SLASH_COMMANDS_MAX);
  });

  it('bounds commands_available as broadcast, and folds the latest for snapshots', () => {
    const first = commands([{ name: 'old' }]);
    const second = commands([{ name: 'new', description: 'y'.repeat(200) }]);
    expect((remoteChatEvent(second) as Extract<ChatEvent, { type: 'commands_available' }>).data.commands).toEqual([{ name: 'new', description: `${'y'.repeat(159)}…` }]);
    expect(latestSlashCommands([first, second])).toEqual([{ name: 'new', description: `${'y'.repeat(159)}…` }]);
    expect(latestSlashCommands([first])).toEqual([{ name: 'old' }]);
    expect(latestSlashCommands([])).toEqual([]);
  });
});
