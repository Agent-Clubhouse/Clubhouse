import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { foldChatEvents, reduceChatEvent, type ChatViewState } from '../../../stores/chatStore';
import { CHAT_STREAM_WINDOW_SIZE, ChatStream } from './ChatStream';
import { chatFixture, ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';
import { NEXT_AGENT_MESSAGE_EVENT, PREVIOUS_AGENT_MESSAGE_EVENT } from '../../../stores/keyboardShortcutsStore';

const ROW_HEIGHT = 100;
const VIEWPORT = 400;

function transcript(turns: number): { state: ChatViewState; fixture: ChatFixture } {
  const prof = PROFILES.claude;
  const f = new ChatFixture();
  f.start(prof.driver, prof.provider, prof.capabilities);
  for (let t = 1; t <= turns; t++) {
    const turn = `turn-${t}`;
    f.prompt(turn, `Step ${t}`);
    f.tool(turn, { toolCallId: `a-${t}`, kind: 'execute', title: 'one', status: 'in_progress', content: [{ type: 'terminal', command: 'one', output: 'ok\n', exitCode: 0 }] });
    f.tool(turn, { toolCallId: `b-${t}`, kind: 'execute', title: 'two', status: 'in_progress', content: [{ type: 'terminal', command: 'two', output: 'ok\n', exitCode: 0 }] });
    f.say(turn, `m-${t}`, `Reply ${t}`);
    f.end(turn, { stopReason: 'end_turn', durationMs: 1000 });
  }
  return { state: foldChatEvents(undefined, FIXTURE_AGENT_ID, f.events), fixture: f };
}

/** jsdom has no layout: every mounted row is ROW_HEIGHT tall, plus whatever a test adds above the rows. */
class FakeLayout {
  above = 0;
  top = 0;
  extraHeight = 0;

  constructor(private readonly el: HTMLElement) {
    const rows = () => el.querySelectorAll<HTMLElement>('[data-block-key]');
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => this.above + rows().length * ROW_HEIGHT + this.extraHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => this.top,
      set: (v: number) => { this.top = Math.max(0, Math.min(v, Math.max(0, el.scrollHeight - VIEWPORT))); },
    });
    el.scrollTo = ((opts: ScrollToOptions) => { el.scrollTop = opts.top ?? 0; }) as typeof el.scrollTo;
    el.getBoundingClientRect = () => ({ top: 0, bottom: VIEWPORT, height: VIEWPORT }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
      const index = [...rows()].indexOf(this);
      const top = this.above(index);
      return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
    } as never);
  }

  rowTop(index: number): number {
    return this.above + index * ROW_HEIGHT - this.top;
  }

  /** A real scroll: the browser moves the view, then the event fires. */
  scrollTo(top: number): void {
    this.el.scrollTop = top;
    fireEvent.scroll(this.el);
  }

  bottom(): number {
    return Math.max(0, this.el.scrollHeight - VIEWPORT);
  }
}

function setup(state: ChatViewState) {
  const view = render(<ChatStream state={state} />);
  const el = screen.getByTestId('chat-stream');
  const layout = new FakeLayout(el);
  const proto = HTMLElement.prototype as unknown as { above: (index: number) => number };
  proto.above = (index) => layout.rowTop(index);
  layout.scrollTo(layout.bottom());
  return { view, el, layout };
}

function resizeContent(): void {
  act(() => { for (const cb of observers) cb([], {} as ResizeObserver); });
}

const observers: ResizeObserverCallback[] = [];
globalThis.ResizeObserver = class {
  constructor(cb: ResizeObserverCallback) { observers.push(cb); }
  observe() { /* fired by resizeContent */ }
  unobserve() { /* nothing to do */ }
  disconnect() { /* nothing to do */ }
} as unknown as typeof ResizeObserver;

afterEach(() => {
  vi.restoreAllMocks();
  observers.length = 0;
});

describe('following the bottom', () => {
  it('stops following on a small upward scroll, and offers Latest there', () => {
    const { layout } = setup(transcript(5).state);
    layout.scrollTo(layout.bottom() - 5);
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
  });

  it('resumes and hides Latest when a tiny upward scroll comes back to the bottom', () => {
    const { layout } = setup(transcript(5).state);
    layout.scrollTo(layout.bottom() - 5);
    layout.scrollTo(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('resumes when content shrinks under a paused reader, with no scroll event', () => {
    const { layout } = setup(transcript(5).state);
    layout.extraHeight = 300;
    layout.scrollTo(layout.bottom() - 200);
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
    layout.extraHeight = 0;
    layout.top = layout.bottom();
    resizeContent();
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('keeps Latest away at the bottom after a layout change such as the keyboard or a resized pane', () => {
    const { layout } = setup(transcript(5).state);
    layout.extraHeight = 120;
    resizeContent();
    // Following: the view went with the content instead of offering Latest.
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('follows new rows at the bottom, but not after the reader has left', () => {
    const { state, fixture } = transcript(5);
    const { view, layout } = setup(state);
    fixture.say('turn-5', 'extra-1', 'More');
    let next = state;
    for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
    view.rerender(<ChatStream state={next} />);
    expect(layout.top).toBe(layout.bottom());

    layout.scrollTo(200);
    const held = layout.top;
    fixture.say('turn-5', 'extra-2', 'More again');
    for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
    view.rerender(<ChatStream state={next} />);
    expect(layout.top).toBe(held);
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
  });

  it('follows again after an explicit Latest', () => {
    const { layout } = setup(transcript(5).state);
    layout.scrollTo(100);
    fireEvent.click(screen.getByTestId('chat-window-latest'));
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });
});

describe('holding the reading position', () => {
  it('holds the reader on the same row when something above it grows', () => {
    const { layout } = setup(transcript(10).state);
    layout.scrollTo(450);
    const before = layout.rowTop(4);
    layout.above = 250;
    resizeContent();
    expect(layout.rowTop(4)).toBe(before);
  });

  it('keeps a window at the tail attached as rows arrive while the reader is away', () => {
    const { state, fixture } = transcript(70);
    const { view, layout } = setup(state);
    layout.scrollTo(layout.bottom() - 300);
    let next = state;
    fixture.say('turn-70', 'extra', 'New row');
    for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
    view.rerender(<ChatStream state={next} />);
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('New row');
    expect(screen.getAllByTestId('chat-stream-block')).toHaveLength(CHAT_STREAM_WINDOW_SIZE);
  });

  it('does not count the bottom of a window that stops short of the tail as the bottom', () => {
    const { layout } = setup(transcript(120).state);
    fireEvent.click(screen.getByTestId('chat-window-older'));
    layout.scrollTo(layout.bottom());
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
  });
});

describe('jumping to a subagent', () => {
  it('goes to a target outside the window even though the reader had a place elsewhere', () => {
    const base = transcript(120).state;
    const subagent = foldChatEvents(undefined, FIXTURE_AGENT_ID, chatFixture('claude', 'subagents'));
    const state = {
      ...base,
      items: [...subagent.items.map((item) => ({ ...item, id: `subagent-fixture:${item.id}` })), ...base.items],
      subagents: subagent.subagents,
      capabilities: subagent.capabilities,
    };
    const { view, layout } = setup(state);
    layout.scrollTo(layout.bottom() - 500);
    view.rerender(<ChatStream state={state} jump={{ subagentId: 'sub-1', nonce: 1 }} />);
    expect(screen.getByTestId('chat-subagent')).toHaveAttribute('data-jump-highlight', 'true');
  });
});

describe('previous and next', () => {
  const landed = (layout: FakeLayout, key: string) => {
    const rows = [...screen.getByTestId('chat-stream').querySelectorAll<HTMLElement>('[data-block-key]')];
    return layout.rowTop(rows.findIndex((r) => r.dataset.blockKey === key));
  };
  const replyKey = (n: number) => {
    const rows = [...screen.getByTestId('chat-stream').querySelectorAll<HTMLElement>('[data-block-key]')];
    const row = rows.find((r) => r.textContent?.includes(`Reply ${n}`) && r.querySelector('[data-testid="chat-agent-message"]'));
    return row!.dataset.blockKey!;
  };

  it('moves between the agent\'s messages only, skipping tools and everyone else', () => {
    const { layout } = setup(transcript(6).state);
    fireEvent.click(screen.getByTestId('chat-nav-previous'));
    const first = landed(layout, replyKey(5));
    expect(first).toBeLessThanOrEqual(8);
    fireEvent.click(screen.getByTestId('chat-nav-previous'));
    expect(landed(layout, replyKey(4))).toBeLessThanOrEqual(8);
    fireEvent.click(screen.getByTestId('chat-nav-next'));
    expect(landed(layout, replyKey(5))).toBeLessThanOrEqual(8);
  });

  it('runs from the keyboard shortcut events', () => {
    const { layout } = setup(transcript(6).state);
    act(() => { window.dispatchEvent(new CustomEvent(PREVIOUS_AGENT_MESSAGE_EVENT)); });
    act(() => { window.dispatchEvent(new CustomEvent(PREVIOUS_AGENT_MESSAGE_EVENT)); });
    expect(landed(layout, replyKey(4))).toBeLessThanOrEqual(8);
    act(() => { window.dispatchEvent(new CustomEvent(NEXT_AGENT_MESSAGE_EVENT)); });
    expect(landed(layout, replyKey(5))).toBeLessThanOrEqual(8);
  });

  it('leaves the shortcut to the focused stream', () => {
    const { state } = transcript(6);
    render(<ChatStream state={state} announce={false} />);
    const el = screen.getByTestId('chat-stream');
    const layout = new FakeLayout(el);
    (HTMLElement.prototype as unknown as { above: (i: number) => number }).above = (i) => layout.rowTop(i);
    layout.top = layout.bottom();
    const before = layout.top;
    act(() => { window.dispatchEvent(new CustomEvent(PREVIOUS_AGENT_MESSAGE_EVENT)); });
    expect(layout.top).toBe(before);
  });

  it('moves the window to reach a stop that is not mounted', () => {
    setup(transcript(120).state);
    expect(screen.queryByText('Reply 1')).not.toBeInTheDocument();
    for (let i = 0; i < 70; i++) fireEvent.click(screen.getByTestId('chat-nav-previous'));
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();
    expect(screen.getByText('Reply 50')).toBeInTheDocument();
  });

  it('offers no buttons with fewer than two stops', () => {
    render(<ChatStream state={transcript(1).state} />);
    expect(screen.queryByTestId('chat-nav-previous')).not.toBeInTheDocument();
  });
});
