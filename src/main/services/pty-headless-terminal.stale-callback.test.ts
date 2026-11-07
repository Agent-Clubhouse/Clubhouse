import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ callbacks: [] as Array<() => void>, serializers: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock('@xterm/headless', () => ({ Terminal: class {
  cols = 80;
  rows = 24;
  options = {};
  loadAddon() {}
  write(_data: string, callback?: () => void) { if (callback) state.callbacks.push(callback); }
  dispose() {}
} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {
  serialize = vi.fn(() => 'screen');
  constructor() { state.serializers.push(this.serialize); }
  dispose() {}
} }));

import { dispose, disposeAll, feedData, reset, snapshot } from './pty-headless-terminal';

afterEach(() => { disposeAll(); state.callbacks.length = 0; state.serializers.length = 0; });

it('ignores a late write callback after disposal settles the snapshot', async () => {
  feedData('a', 'old', 3);
  const pending = snapshot('a');
  const late = state.callbacks[0];
  dispose('a');
  try {
    expect(await pending).toBeNull();
    late();
    expect(state.serializers[0]).not.toHaveBeenCalled();
  } finally { disposeAll(); await pending; }
});

it('ignores an old callback during reset and settles through the replacement', async () => {
  feedData('a', 'old', 3);
  const pending = snapshot('a');
  const late = state.callbacks[0];
  reset('a');
  feedData('a', 'fresh', 8);
  // Await an explicit replacement-write admission, not a guessed timer delay.
  // The abandoned snapshot schedules its replacement in a promise continuation.
  try {
    late();
    expect(state.serializers[0]).not.toHaveBeenCalled();
    // A separately queued snapshot provides a captured callback immediately;
    // settle both replacement snapshots through their own write callbacks.
    const control = snapshot('a');
    state.callbacks[1]();
    expect(await control).toEqual({ data: 'screen', seq: 8 });
    state.callbacks[2]();
    expect(await pending).toEqual({ data: 'screen', seq: 8 });
    late();
    expect(state.serializers[0]).not.toHaveBeenCalled();
  } finally { disposeAll(); await pending; }
});

it('keeps the sequence captured by a current-session snapshot', async () => {
  feedData('a', 'first', 5);
  const pending = snapshot('a');
  feedData('a', ' second', 12);
  try {
    state.callbacks[0]();
    expect(await pending).toEqual({ data: 'screen', seq: 5 });
    expect(state.serializers[0]).toHaveBeenCalledTimes(1);
  } finally { disposeAll(); await pending; }
});
