import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_WINDOW_MS,
  HELD_MAX,
  applyTriage,
  emptyTriageState,
  isNewsKind,
  revertShown,
  sameNewsKey,
  triageNews,
  type NewsItem,
  type TriageState,
} from './dispatcher-triage';

const T0 = 1_700_000_000_000;

function news(kind: NewsItem['kind'], text: string, extra: Partial<NewsItem> = {}): NewsItem {
  return { kind, text, at: T0, ...extra };
}

/** Run one report through the rules and return the decision and the next state. */
function step(state: TriageState, item: NewsItem, now = item.at) {
  const decision = triageNews(item, state, now);
  return { decision, state: applyTriage(state, item, decision, now) };
}

describe('triageNews', () => {
  it('shows news that needs the person right away', () => {
    expect(triageNews(news('needs_user', 'Can I delete the old branch?'), emptyTriageState(), T0)).toEqual({ show: 'now', reason: 'needs_user' });
  });

  it('shows an answer to one of the person\'s requests right away (#3204)', () => {
    expect(triageNews(news('answer', 'Checkout is fixed.', { request: 'req_1' }), emptyTriageState(), T0)).toEqual({ show: 'now', reason: 'answer' });
  });

  it('holds an answer that is for no request', () => {
    expect(triageNews(news('answer', 'Checkout is fixed.'), emptyTriageState(), T0)).toEqual({ show: 'later', reason: 'nothing_asked' });
  });

  it('holds routine news for the next check-in', () => {
    expect(triageNews(news('routine', 'Lint is green again.'), emptyTriageState(), T0)).toEqual({ show: 'later', reason: 'routine' });
  });

  it('never shows a report with nothing left in it', () => {
    expect(triageNews(news('needs_user', '   '), emptyTriageState(), T0)).toEqual({ show: 'never', reason: 'empty' });
    expect(triageNews(news('check_in', ''), emptyTriageState(), T0)).toEqual({ show: 'never', reason: 'empty' });
  });

  it('never shows the same news from the same agent twice', () => {
    let { state } = step(emptyTriageState(), news('needs_user', 'Can I merge #412?', { fromAgentId: 'a1' }));
    expect(triageNews(news('needs_user', 'can I merge #412', { fromAgentId: 'a1', at: T0 + 10 }), state, T0 + 10)).toEqual({ show: 'never', reason: 'duplicate' });
    // Another agent saying the same thing is its own news.
    expect(triageNews(news('needs_user', 'Can I merge #412?', { fromAgentId: 'a2' }), state, T0 + 10).show).toBe('now');
    // So is the same question after the window.
    const later = T0 + DUPLICATE_WINDOW_MS + 1;
    expect(triageNews(news('needs_user', 'Can I merge #412?', { fromAgentId: 'a1', at: later }), state, later).show).toBe('now');
    // News already waiting for a check-in is a repeat too.
    ({ state } = step(state, news('routine', 'Lint is green.', { fromAgentId: 'a1' })));
    expect(triageNews(news('routine', 'Lint is green', { fromAgentId: 'a1' }), state, T0).show).toBe('never');
  });

  it('shows a check-in only when news is waiting for it', () => {
    expect(triageNews(news('check_in', 'All quiet.'), emptyTriageState(), T0)).toEqual({ show: 'never', reason: 'nothing_changed' });
    const { state } = step(emptyTriageState(), news('routine', 'Lint is green.', { fromAgentId: 'a1', fromName: 'webapp-lead' }));
    const decision = triageNews(news('check_in', 'webapp-lead fixed lint.'), state, T0);
    expect(decision.show).toBe('check_in');
    expect(decision.show === 'check_in' && decision.held.map((h) => h.text)).toEqual(['Lint is green.']);
  });

  it('never treats a check-in as a repeat: the held news decides', () => {
    let { state } = step(emptyTriageState(), news('routine', 'A.'));
    ({ state } = step(state, news('check_in', 'Summary.')));
    ({ state } = step(state, news('routine', 'B.')));
    expect(triageNews(news('check_in', 'Summary.'), state, T0).show).toBe('check_in');
  });
});

describe('applyTriage', () => {
  it('remembers what was shown, and leaves requests to dispatcher-requests', () => {
    const { state } = step(emptyTriageState(), news('answer', 'First is done.', { request: 'req_1' }));
    expect(state).toEqual({ held: [], shown: [{ text: 'First is done.', fromAgentId: undefined, at: T0 }] });
  });

  it('empties the held news into a check-in', () => {
    let { state } = step(emptyTriageState(), news('routine', 'A.', { fromAgentId: 'a1', fromName: 'one' }));
    ({ state } = step(state, news('answer', 'B.')));
    expect(state.held).toEqual([{ text: 'A.', fromAgentId: 'a1', fromName: 'one', at: T0 }, { text: 'B.', at: T0 }]);
    ({ state } = step(state, news('check_in', 'Two things happened.'), T0 + 5));
    expect(state.held).toEqual([]);
    expect(state.lastCheckInAt).toBe(T0 + 5);
    // Nothing new since: the next check-in isn't shown.
    expect(triageNews(news('check_in', 'Two things happened.'), state, T0 + 10)).toEqual({ show: 'never', reason: 'nothing_changed' });
  });

  it('keeps at most HELD_MAX held items, dropping the oldest', () => {
    let state = emptyTriageState();
    for (let i = 0; i < HELD_MAX + 5; i++) ({ state } = step(state, news('routine', `News ${i}.`)));
    expect(state.held).toHaveLength(HELD_MAX);
    expect(state.held[0].text).toBe('News 5.');
  });

  it('changes nothing for news that is never shown', () => {
    const state = emptyTriageState();
    expect(step(state, news('needs_user', '')).state).toBe(state);
  });
});

describe('helpers', () => {
  it('compares news without case, spacing or punctuation', () => {
    expect(sameNewsKey('Fixed in #412!  All good.')).toBe(sameNewsKey('fixed in #412 all good'));
  });

  it('knows the kinds', () => {
    expect(isNewsKind('routine')).toBe(true);
    expect(isNewsKind('urgent')).toBe(false);
    expect(isNewsKind(undefined)).toBe(false);
  });
});

describe('revertShown (#3193)', () => {
  it('forgets news that never reached the chat, so it can be sent again', () => {
    const before = emptyTriageState();
    const item = news('answer', 'Tagged 1.0.', { fromAgentId: 'a1', request: 'req_1' });
    const decision = triageNews(item, before, T0);
    const after = applyTriage(before, item, decision, T0);
    expect(triageNews(item, after, T0).show).toBe('never');
    const reverted = revertShown(after, item, decision);
    expect(reverted.shown).toEqual([]);
    expect(triageNews(item, reverted, T0)).toEqual({ show: 'now', reason: 'answer' });
  });

  it('holds again what a check-in took, and changes nothing for news that was held', () => {
    let { state } = step(emptyTriageState(), news('routine', 'A.'));
    const held = step(state, news('routine', 'B.'));
    expect(revertShown(held.state, news('routine', 'B.'), held.decision)).toBe(held.state);
    state = held.state;
    const checkIn = news('check_in', 'Two things.');
    const { decision, state: after } = step(state, checkIn);
    expect(after.held).toEqual([]);
    expect(revertShown(after, checkIn, decision).held.map((h) => h.text)).toEqual(['A.', 'B.']);
  });
});
