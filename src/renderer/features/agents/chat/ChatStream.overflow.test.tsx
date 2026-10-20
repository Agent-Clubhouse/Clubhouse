import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fireEvent, render, screen } from '@testing-library/react';
import { foldChatEvents } from '../../../stores/chatStore';
import { ChatStream } from './ChatStream';
import { ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';

const rendererLog = vi.hoisted(() => vi.fn());
vi.mock('../../../plugins/renderer-logger', () => ({ rendererLog }));

const TOKEN = `sha256-${'a1b2c3d4'.repeat(60)}`;
const PATH = `/workspace/project/${Array.from({ length: 30 }, (_, i) => `segment${i}`).join('/')}/index.ts`;
const PARAGRAPH = Array.from({ length: 80 }, () => 'restored conversation text').join(' ');
const TABLE = [
  `| ${Array.from({ length: 14 }, (_, i) => `column ${i}`).join(' | ')} |`,
  `|${' --- |'.repeat(14)}`,
  `| ${Array.from({ length: 14 }, () => 'a fairly long cell value').join(' | ')} |`,
].join('\n');

/**
 * A Copilot conversation as a woken session shows it (#2292): Copilot's
 * session/load replay is dropped and the stream mounts fresh on Clubhouse's
 * own transcript, here with long paragraphs, unbroken tokens and a wide table.
 */
function wokenCopilotState() {
  const prof = PROFILES.copilot;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  f.prompt('t1', `Check ${TOKEN}`);
  f.say('t1', 'm1', `${PARAGRAPH}\n\nThe file is \`${PATH}\` and the digest ${TOKEN}.\n\n${TABLE}`);
  f.end('t1', { stopReason: 'end_turn' });
  return foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events);
}

function cssRule(selector: string): string {
  const css = fs.readFileSync(path.resolve(__dirname, '../../../index.css'), 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('ChatStream: restored text stays inside the pane (#2292)', () => {
  beforeEach(() => rendererLog.mockClear());

  it('renders the restored history', () => {
    render(<ChatStream state={wokenCopilotState()} announce={false} />);
    expect(screen.getByTestId('chat-agent-message')).toHaveTextContent(TOKEN);
    expect(screen.getByTestId('chat-agent-message').querySelector('table')).not.toBeNull();
  });

  it('never scrolls the conversation sideways', () => {
    render(<ChatStream state={wokenCopilotState()} announce={false} />);
    const stream = screen.getByTestId('chat-stream');
    expect(stream).toHaveClass('overflow-x-hidden');
    expect(stream.firstElementChild).toHaveClass('min-w-0');
  });

  it('puts a sideways-scrolled stream back at the left edge and logs it once', () => {
    render(<ChatStream state={wokenCopilotState()} announce={false} />);
    const stream = screen.getByTestId('chat-stream');
    stream.scrollLeft = 140;
    fireEvent.scroll(stream);
    expect(stream.scrollLeft).toBe(0);
    stream.scrollLeft = 60;
    fireEvent.scroll(stream);
    expect(stream.scrollLeft).toBe(0);
    expect(rendererLog).toHaveBeenCalledTimes(1);
    expect(rendererLog).toHaveBeenCalledWith('app:chat', 'warn', expect.stringContaining('scrolled sideways'), expect.objectContaining({
      meta: expect.objectContaining({ scrollLeft: 140, provider: 'copilot-cli' }),
    }));
  });

  it('breaks long tokens in user bubbles instead of widening them past the pane', () => {
    render(<ChatStream state={wokenCopilotState()} announce={false} />);
    const wrapper = screen.getByTestId('chat-user-message');
    const bubble = wrapper.lastElementChild as HTMLElement;
    expect(bubble).toHaveTextContent(TOKEN);
    expect(bubble).toHaveClass('wrap-anywhere', 'max-w-full');
    expect(wrapper).toHaveClass('min-w-0');
  });

  it('keeps markdown tokens and tables inside the message column', () => {
    expect(cssRule('.chat-markdown')).toMatch(/overflow-wrap:\s*anywhere/);
    const table = cssRule('.chat-markdown table');
    expect(table).toMatch(/display:\s*block/);
    expect(table).toMatch(/max-width:\s*100%/);
    expect(table).toMatch(/overflow-x:\s*auto/);
    expect(cssRule('.chat-markdown td')).toMatch(/overflow-wrap:\s*normal/);
  });
});
