import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { foldChatEvents, reduceChatEvent, type ChatViewState } from '../../../stores/chatStore';
import { CHAT_STREAM_WINDOW_SIZE, ChatStream } from './ChatStream';
import { chatFixture, ChatFixture, FIXTURE_AGENT_ID, PROFILES } from './fixtures';
import { NEXT_AGENT_MESSAGE_EVENT, PREVIOUS_AGENT_MESSAGE_EVENT } from '../../../stores/keyboardShortcutsStore';

const rendererLog = vi.hoisted(() => vi.fn());
vi.mock('../../../plugins/renderer-logger', () => ({ rendererLog }));

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
  viewport = VIEWPORT;

  constructor(private readonly el: HTMLElement) {
    const rows = () => el.querySelectorAll<HTMLElement>('[data-block-key]');
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => this.viewport });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => this.above + rows().length * ROW_HEIGHT + this.extraHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => this.top,
      set: (v: number) => { this.top = Math.max(0, Math.min(v, Math.max(0, el.scrollHeight - this.viewport))); },
    });
    el.scrollTo = ((opts: ScrollToOptions) => { el.scrollTop = opts.top ?? 0; }) as typeof el.scrollTo;
    el.getBoundingClientRect = () => ({ top: 0, bottom: this.viewport, height: this.viewport }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
      const index = [...rows()].indexOf(this);
      const top = this.above(index);
      return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
    } as never);
  }

  rowTop(index: number): number {
    return this.above + index * ROW_HEIGHT - this.top;
  }

  /** A real scroll: the reader's input, then the browser moves the view, then the event fires. */
  scrollTo(top: number): void {
    fireEvent.wheel(this.el, { deltaY: top - this.top });
    this.el.scrollTop = top;
    fireEvent.scroll(this.el);
  }

  bottom(): number {
    return Math.max(0, this.el.scrollHeight - this.viewport);
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
  rendererLog.mockClear();
  observers.length = 0;
});

function addRow(fixture: ChatFixture, state: ChatViewState, turn: string, id: string): ChatViewState {
  fixture.say(turn, id, `Row ${id}`);
  let next = state;
  for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
  return next;
}

describe('a reader at the bottom has no saved place (#2748)', () => {
  it('does not go back to a row read earlier when the view is moved under it as a row arrives', () => {
    const { state, fixture } = transcript(10);
    const { view, el, layout } = setup(state);
    layout.scrollTo(200);
    layout.scrollTo(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();

    // A clamp nobody asked for, then a row, before the scroll event.
    layout.top = layout.bottom() - 300;
    view.rerender(<ChatStream state={addRow(fixture, state, 'turn-10', 'after-clamp')} />);
    resizeContent();
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('has no place to go back to after Latest, as new rows arrive', () => {
    const { state, fixture } = transcript(10);
    const { view, el, layout } = setup(state);
    layout.scrollTo(200);
    fireEvent.click(screen.getByTestId('chat-window-latest'));
    expect(layout.top).toBe(layout.bottom());

    layout.top = layout.bottom() - 300;
    view.rerender(<ChatStream state={addRow(fixture, state, 'turn-10', 'after-latest')} />);
    resizeContent();
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('never re-centers the window on an old row while pinned', () => {
    const { state, fixture } = transcript(120);
    const { view, el, layout } = setup(state);
    // Save a place far back, in another window, then come back with Latest.
    fireEvent.click(screen.getByTestId('chat-window-older'));
    layout.scrollTo(100);
    fireEvent.click(screen.getByTestId('chat-window-latest'));
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();

    layout.top = 0;
    const next = addRow(fixture, state, 'turn-120', 'pinned-row');
    view.rerender(<ChatStream state={next} />);
    fireEvent.scroll(el);
    view.rerender(<ChatStream state={addRow(fixture, next, 'turn-120', 'pinned-row-2')} />);
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Row pinned-row-2');
    expect(layout.top).toBe(layout.bottom());
  });
});

describe('only a user scroll stops a pinned view following (#2748)', () => {
  const inputs: Array<[string, (el: HTMLElement) => void]> = [
    ['the wheel or a trackpad', (el) => { fireEvent.wheel(el, { deltaY: -120 }); }],
    ['a key', () => { fireEvent.keyDown(document.body, { key: 'PageUp' }); }],
    ['a scrollbar or a selection drag', (el) => { fireEvent.pointerDown(el); }],
    ['a touch', (el) => { fireEvent.touchMove(el); }],
  ];

  it.each(inputs)('pauses straight away for %s', (_name, input) => {
    const { state, fixture } = transcript(10);
    const { view, el, layout } = setup(state);
    input(el);
    layout.top = layout.bottom() - 250;
    fireEvent.scroll(el);
    const held = layout.top;
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
    view.rerender(<ChatStream state={addRow(fixture, state, 'turn-10', 'while-away')} />);
    expect(layout.top).toBe(held);
  });

  it('goes back to the bottom when anything else moved it', () => {
    const { el, layout } = setup(transcript(10).state);
    layout.top = 100;
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('does not count a wheel going down, or one long finished', () => {
    const { el, layout } = setup(transcript(10).state);
    fireEvent.wheel(el, { deltaY: 120 });
    layout.top = 100;
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fireEvent.wheel(el, { deltaY: -120 });
    now.mockReturnValue(1_002_000);
    layout.top = 100;
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
  });

  it('does not count keys typed in the composer', () => {
    const { el, layout } = setup(transcript(10).state);
    const composer = document.body.appendChild(document.createElement('textarea'));
    fireEvent.keyDown(composer, { key: 'ArrowUp' });
    composer.remove();
    layout.top = 100;
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
  });

  it('stops counting a pointer once it is released', () => {
    const { el, layout } = setup(transcript(10).state);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fireEvent.pointerDown(el);
    fireEvent.pointerUp(window);
    now.mockReturnValue(1_002_000);
    layout.top = 100;
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
  });

  it('stays at the bottom when content shrinks, even as a row arrives', () => {
    const { state, fixture } = transcript(10);
    const { view, el, layout } = setup(state);
    layout.extraHeight = 600;
    resizeContent();
    expect(layout.top).toBe(layout.bottom());

    // Folded or closed: the browser clamps scrollTop to the smaller range.
    layout.extraHeight = 0;
    layout.top = layout.bottom();
    view.rerender(<ChatStream state={addRow(fixture, state, 'turn-10', 'after-shrink')} />);
    fireEvent.scroll(el);
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('follows when the dock changes the view, without the rows changing', () => {
    const { layout } = setup(transcript(10).state);
    layout.viewport = VIEWPORT - 150;
    resizeContent();
    expect(layout.top).toBe(layout.bottom());
    layout.viewport = VIEWPORT + 150;
    layout.top = layout.bottom();
    resizeContent();
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('keeps a paused reader paused while the stream is hidden for a review', () => {
    const { layout } = setup(transcript(10).state);
    layout.scrollTo(200);
    const held = layout.top;
    const shown = layout.viewport;
    layout.viewport = 0;
    resizeContent();
    layout.viewport = shown;
    layout.top = held;
    resizeContent();
    expect(layout.top).toBe(held);
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
  });
});

describe('sending returns to the bottom (#2748)', () => {
  it('stays at the bottom when sent from there', () => {
    const { state, fixture } = transcript(10);
    const { view, layout } = setup(state);
    view.rerender(<ChatStream state={state} latestRequest={1} />);
    const next = addRow(fixture, state, 'turn-10', 'sent');
    view.rerender(<ChatStream state={next} latestRequest={1} />);
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });

  it('comes back from a reader far up, and from another window', () => {
    const { state } = transcript(120);
    const { view, layout } = setup(state);
    fireEvent.click(screen.getByTestId('chat-window-older'));
    layout.scrollTo(100);
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();
    view.rerender(<ChatStream state={state} latestRequest={1} />);
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();
    expect(layout.top).toBe(layout.bottom());
    expect(screen.queryByTestId('chat-window-latest')).not.toBeInTheDocument();
  });
});

describe('reading older messages while rows arrive (#2748)', () => {
  it('holds the reader on the same row as new rows slide the window', () => {
    const { state, fixture } = transcript(70);
    const { view, el, layout } = setup(state);
    layout.scrollTo(layout.bottom() - 800);
    const firstMounted = () => el.querySelector<HTMLElement>('[data-block-index]')!;
    const rows = () => [...el.querySelectorAll<HTMLElement>('[data-block-key]')];
    const read = rows()[Math.floor(layout.top / ROW_HEIGHT)].dataset.blockKey!;
    const before = layout.rowTop(rows().findIndex((r) => r.dataset.blockKey === read));
    const firstBefore = firstMounted().dataset.blockIndex;

    let next = state;
    for (const id of ['slide-1', 'slide-2', 'slide-3']) {
      next = addRow(fixture, next, 'turn-70', id);
      view.rerender(<ChatStream state={next} />);
    }
    expect(firstMounted().dataset.blockIndex).not.toBe(firstBefore);
    expect(layout.rowTop(rows().findIndex((r) => r.dataset.blockKey === read))).toBe(before);
    expect(screen.getAllByTestId('chat-agent-message').at(-1)).toHaveTextContent('Row slide-3');
    expect(screen.getByTestId('chat-window-latest')).toBeInTheDocument();
  });
});

describe('scroll logging (#2748)', () => {
  const lines = () => rendererLog.mock.calls.filter(([, , msg]) => /following|moved more than/.test(String(msg)));

  it('writes nothing while following in ordinary use', () => {
    const { state, fixture } = transcript(10);
    const { view, layout } = setup(state);
    let next = state;
    for (const id of ['n1', 'n2', 'n3']) {
      next = addRow(fixture, next, 'turn-10', id);
      view.rerender(<ChatStream state={next} latestRequest={1} />);
      layout.extraHeight += 40;
      resizeContent();
    }
    expect(lines()).toEqual([]);
  });

  it('says when following stops and resumes, and why', () => {
    const { layout } = setup(transcript(10).state);
    layout.scrollTo(100);
    expect(rendererLog).toHaveBeenLastCalledWith('app:chat', 'info', 'Chat stopped following the bottom', expect.objectContaining({
      meta: expect.objectContaining({ why: 'wheel', start: expect.any(Number), end: expect.any(Number), blocks: expect.any(Number) }),
    }));
    fireEvent.click(screen.getByTestId('chat-window-latest'));
    expect(rendererLog).toHaveBeenLastCalledWith('app:chat', 'info', 'Chat resumed following the bottom', expect.objectContaining({
      meta: expect.objectContaining({ why: 'latest', pinned: true }),
    }));
  });

  it('records a large move nobody scrolled, with what it can say about the cause', () => {
    const { el, layout } = setup(transcript(10).state);
    rendererLog.mockClear();
    const bottom = layout.top;
    layout.top = 0;
    fireEvent.scroll(el);
    expect(lines()).toHaveLength(1);
    const [ns, level, , opts] = lines()[0];
    expect([ns, level]).toEqual(['app:chat', 'warn']);
    expect(opts.meta).toMatchObject({
      cause: 'unknown',
      before: { scrollTop: bottom, clientHeight: VIEWPORT },
      after: { scrollTop: 0, clientHeight: VIEWPORT },
      followTail: true,
      pinned: true,
      anchorIndex: null,
    });
    expect(layout.top).toBe(bottom);
  });

  it('names a clamp when the content shrank under the view', () => {
    const { el, layout } = setup(transcript(10).state);
    layout.extraHeight = VIEWPORT * 2;
    resizeContent();
    rendererLog.mockClear();
    layout.extraHeight = 0;
    layout.top = layout.bottom();
    fireEvent.scroll(el);
    expect(lines()[0][3].meta.cause).toBe('clamp');
  });

  it('holds no message text, row keys or paths, and limits how much it writes', () => {
    const { el, layout } = setup(transcript(10).state);
    const rowKeys = [...el.querySelectorAll<HTMLElement>('[data-block-key]')].map((r) => r.dataset.blockKey!);
    for (let i = 0; i < 40; i++) {
      layout.scrollTo(100 + i);
      layout.top = layout.bottom();
      resizeContent();
      fireEvent.click(screen.queryByTestId('chat-window-latest') ?? el);
      layout.top = 0;
      fireEvent.scroll(el);
    }
    const written = JSON.stringify(lines());
    expect(lines().length).toBeLessThanOrEqual(12);
    expect(lines().length).toBeGreaterThan(0);
    for (const text of ['Step ', 'Reply ', '/', '\\\\', ...rowKeys]) expect(written).not.toContain(text);
  });
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
    resizeContent();
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

describe('reaching Show earlier while the agent streams', () => {
  const grow = (fixture: ChatFixture, state: ChatViewState, id: string) => {
    let next = state;
    fixture.say('turn-120', id, `Streamed ${id}`);
    for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
    return next;
  };

  it('stays there as rows keep arriving, and a click loads earlier history', () => {
    const onShowEarlier = vi.fn();
    const { state, fixture } = transcript(120);
    const view = render(<ChatStream state={state} onShowEarlier={onShowEarlier} />);
    const layout = new FakeLayout(screen.getByTestId('chat-stream'));
    (HTMLElement.prototype as unknown as { above: (i: number) => number }).above = (i) => layout.rowTop(i);
    layout.scrollTo(layout.bottom());
    for (let i = 0; i < 3 && screen.queryByTestId('chat-window-older'); i++) fireEvent.click(screen.getByTestId('chat-window-older'));
    layout.scrollTo(0);
    let next = state;
    for (const id of ['s1', 's2', 's3']) {
      next = grow(fixture, next, id);
      view.rerender(<ChatStream state={next} onShowEarlier={onShowEarlier} />);
      expect(screen.getByTestId('chat-show-earlier')).toBeInTheDocument();
    }
    expect(layout.top).toBe(0);
    fireEvent.click(screen.getByTestId('chat-show-earlier'));
    expect(onShowEarlier).toHaveBeenCalledOnce();
  });

  it('is reached from a window at the tail, with rows arriving as Show older is clicked', () => {
    const { state, fixture } = transcript(120);
    const onShowEarlier = vi.fn();
    const view = render(<ChatStream state={state} onShowEarlier={onShowEarlier} />);
    const layout = new FakeLayout(screen.getByTestId('chat-stream'));
    (HTMLElement.prototype as unknown as { above: (i: number) => number }).above = (i) => layout.rowTop(i);
    layout.scrollTo(layout.bottom());
    const next = grow(fixture, state, 's1');
    act(() => {
      fireEvent.click(screen.getByTestId('chat-window-older'));
      view.rerender(<ChatStream state={next} onShowEarlier={onShowEarlier} />);
    });
    // The click won: the window moved back, and didn't slide to the tail with the new row.
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();
  });

  it('does not snap a reader back when rows arrive before their scroll event', () => {
    const { state, fixture } = transcript(10);
    const { view, el, layout } = setup(state);
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fireEvent.wheel(el, { deltaY: -200 });
    layout.top = layout.bottom() - 200;
    const held = layout.top;
    fixture.say('turn-10', 'x', 'More');
    let next = state;
    for (const e of fixture.events.slice(-2)) next = reduceChatEvent(next, e);
    view.rerender(<ChatStream state={next} />);
    expect(layout.top).toBe(held);
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
    const { layout } = setup(transcript(120).state);
    expect(screen.queryByText('Reply 1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-window-later')).not.toBeInTheDocument();

    // Start at the window's top edge, so the next stop back isn't mounted.
    layout.scrollTo(0);
    const replies = [...screen.getByTestId('chat-stream').querySelectorAll('[data-testid="chat-agent-message"]')];
    const earliest = Number(/Reply (\d+)/.exec(replies[0].textContent ?? '')![1]);
    expect(screen.queryByText(`Reply ${earliest - 1}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-nav-previous'));
    expect(screen.getByTestId('chat-window-later')).toBeInTheDocument();
    expect(landed(layout, replyKey(earliest - 1))).toBeLessThanOrEqual(8);

    // The window has moved, and Previous carries on from there.
    fireEvent.click(screen.getByTestId('chat-nav-previous'));
    expect(landed(layout, replyKey(earliest - 2))).toBeLessThanOrEqual(8);
  });

  it('offers no buttons with fewer than two stops', () => {
    render(<ChatStream state={transcript(1).state} />);
    expect(screen.queryByTestId('chat-nav-previous')).not.toBeInTheDocument();
  });
});
