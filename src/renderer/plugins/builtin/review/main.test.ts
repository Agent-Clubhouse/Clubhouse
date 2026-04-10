import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as reviewModule from './main';
import { createMockContext, createMockAPI } from '../../testing';
import type { AgentInfo, PluginAgentDetailedStatus, PluginAPI } from '../../../../shared/plugin-types';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'alpha',
    kind: 'durable',
    status: 'running',
    color: '#ff0000',
    projectId: 'proj-1',
    ...overrides,
  };
}

describe('review main', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: reviewModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate registers review-prev and review-next commands', () => {
    const ctx = createMockContext({ pluginId: 'review', scope: 'dual' });
    const registerFn = vi.fn(() => ({ dispose: () => {} }));
    const api = createMockAPI({
      commands: {
        register: registerFn,
        execute: async () => {},
        registerWithHotkey: () => ({ dispose: () => {} }),
        getBinding: () => null,
        clearBinding: () => {},
      },
    });

    reviewModule.activate(ctx, api);

    expect(registerFn).toHaveBeenCalledWith('review-prev', expect.any(Function));
    expect(registerFn).toHaveBeenCalledWith('review-next', expect.any(Function));
  });

  it('activate pushes disposables to ctx.subscriptions', () => {
    const ctx = createMockContext({ pluginId: 'review', scope: 'dual' });
    const api = createMockAPI();

    reviewModule.activate(ctx, api);

    expect(ctx.subscriptions).toHaveLength(2);
    expect(typeof ctx.subscriptions[0].dispose).toBe('function');
    expect(typeof ctx.subscriptions[1].dispose).toBe('function');
  });

  it('deactivate does not throw', () => {
    expect(() => reviewModule.deactivate()).not.toThrow();
  });

  it('exports MainPanel component', () => {
    expect(reviewModule.MainPanel).toBeDefined();
    expect(typeof reviewModule.MainPanel).toBe('function');
  });
});

describe('filterAgents', () => {
  const running = makeAgent({ id: 'a1', status: 'running' });
  const sleeping = makeAgent({ id: 'a2', status: 'sleeping' });
  const creating = makeAgent({ id: 'a3', status: 'creating' });
  const errored = makeAgent({ id: 'a4', status: 'error' });

  it('returns all agents when includeSleeping is true', () => {
    const result = reviewModule.filterAgents([running, sleeping, creating, errored], true);
    expect(result).toHaveLength(4);
  });

  it('excludes sleeping agents when includeSleeping is false', () => {
    const result = reviewModule.filterAgents([running, sleeping, creating, errored], false);
    expect(result).toHaveLength(3);
    expect(result.find((a) => a.id === 'a2')).toBeUndefined();
  });

  it('returns empty array when all agents are sleeping and includeSleeping is false', () => {
    const result = reviewModule.filterAgents([sleeping], false);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterAgents([], true);
    expect(result).toHaveLength(0);
  });
});

describe('filterNeedsAttention', () => {
  const running = makeAgent({ id: 'a1', status: 'running' });
  const errored = makeAgent({ id: 'a2', status: 'error' });
  const needsPerm = makeAgent({ id: 'a3', status: 'running' });
  const toolErr = makeAgent({ id: 'a4', status: 'running' });
  const idle = makeAgent({ id: 'a5', status: 'running' });

  function makeStatuses(entries: [string, PluginAgentDetailedStatus | null][]): Map<string, PluginAgentDetailedStatus | null> {
    return new Map(entries);
  }

  it('filters to only error/needs_permission/tool_error agents', () => {
    const statuses = makeStatuses([
      ['a1', { state: 'working', message: '' }],
      ['a2', null],
      ['a3', { state: 'needs_permission', message: 'Needs permission' }],
      ['a4', { state: 'tool_error', message: 'Tool error' }],
      ['a5', { state: 'idle', message: '' }],
    ]);
    const result = reviewModule.filterNeedsAttention(
      [running, errored, needsPerm, toolErr, idle],
      statuses,
    );
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id)).toEqual(['a2', 'a3', 'a4']);
  });

  it('includes agents with status "error" even without detailed status', () => {
    const statuses = makeStatuses([
      ['a2', null],
    ]);
    const result = reviewModule.filterNeedsAttention([errored], statuses);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a2');
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterNeedsAttention([], new Map());
    expect(result).toHaveLength(0);
  });

  it('excludes agents that are working or idle', () => {
    const statuses = makeStatuses([
      ['a1', { state: 'working', message: '' }],
      ['a5', { state: 'idle', message: '' }],
    ]);
    const result = reviewModule.filterNeedsAttention([running, idle], statuses);
    expect(result).toHaveLength(0);
  });
});

describe('filterRemoteAgents', () => {
  const local1 = makeAgent({ id: 'agent-1', name: 'local-alpha' });
  const local2 = makeAgent({ id: 'agent-2', name: 'local-beta' });
  const remote1 = makeAgent({ id: 'remote||sat1||r-agent-1', name: 'remote-alpha' });
  const remote2 = makeAgent({ id: 'remote||sat2||r-agent-2', name: 'remote-beta' });

  it('returns all agents when includeRemote is true', () => {
    const result = reviewModule.filterRemoteAgents([local1, remote1, local2, remote2], true);
    expect(result).toHaveLength(4);
  });

  it('excludes remote agents when includeRemote is false', () => {
    const result = reviewModule.filterRemoteAgents([local1, remote1, local2, remote2], false);
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.id)).toEqual(['agent-1', 'agent-2']);
  });

  it('returns empty array when all agents are remote and includeRemote is false', () => {
    const result = reviewModule.filterRemoteAgents([remote1, remote2], false);
    expect(result).toHaveLength(0);
  });

  it('returns all local agents when there are no remote agents', () => {
    const result = reviewModule.filterRemoteAgents([local1, local2], false);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    const result = reviewModule.filterRemoteAgents([], false);
    expect(result).toHaveLength(0);
  });
});

describe('resolveIndex', () => {
  it('wraps forward at the end', () => {
    expect(reviewModule.resolveIndex(4, 5, 1)).toBe(0);
  });

  it('wraps backward at the start', () => {
    expect(reviewModule.resolveIndex(0, 5, -1)).toBe(4);
  });

  it('advances forward normally', () => {
    expect(reviewModule.resolveIndex(2, 5, 1)).toBe(3);
  });

  it('goes backward normally', () => {
    expect(reviewModule.resolveIndex(2, 5, -1)).toBe(1);
  });

  it('returns 0 for empty list', () => {
    expect(reviewModule.resolveIndex(0, 0, 1)).toBe(0);
    expect(reviewModule.resolveIndex(0, 0, -1)).toBe(0);
  });

  it('stays at 0 for single-element list', () => {
    expect(reviewModule.resolveIndex(0, 1, 1)).toBe(0);
    expect(reviewModule.resolveIndex(0, 1, -1)).toBe(0);
  });
});

describe('FloatingBar layout', () => {
  const noop = () => {};
  const StubAvatar = () => React.createElement('span', null, 'A');

  function renderBar(overrides: Partial<Parameters<typeof reviewModule.FloatingBar>[0]> = {}) {
    return render(
      React.createElement(reviewModule.FloatingBar, {
        currentIndex: 0,
        total: 22,
        agentId: 'agent-1',
        agentName: 'alpha',
        agentStatus: 'running',
        detailedState: null,
        AgentAvatar: StubAvatar,
        isRunning: true,
        onSleep: noop,
        includeSleeping: false,
        onToggleSleeping: noop,
        needsAttentionOnly: false,
        onToggleNeedsAttention: noop,
        includeRemote: false,
        onToggleIncludeRemote: noop,
        agents: [makeAgent()],
        onJumpTo: noop,
        onPrev: noop,
        onNext: noop,
        ...overrides,
      }),
    );
  }

  it('renders agent counter on a single line (no text wrapping)', () => {
    const { container } = renderBar({ currentIndex: 0, total: 22 });
    const counterSpan = container.querySelector('span.text-ctp-subtext0');
    expect(counterSpan).not.toBeNull();
    expect(counterSpan!.textContent).toBe('(running)');
    // The bar container should prevent wrapping
    const bar = container.firstElementChild!;
    expect(bar.className).toContain('whitespace-nowrap');
  });

  it('agent info section prevents text wrapping', () => {
    const { container } = renderBar();
    // The agent info span wraps avatar + name + status + counter
    const agentInfo = container.querySelector('span.flex.items-center.gap-1\\.5');
    expect(agentInfo).not.toBeNull();
    expect(agentInfo!.className).toContain('whitespace-nowrap');
  });

  // ── Mission 66: arrow positions must NOT shift with agent name length ──
  //
  // Strategy: jsdom does not compute layout (offsetLeft/getBoundingClientRect
  // are 0), so we can't measure actual pixel positions. Instead we verify the
  // *mechanism* — the agent-info wrapper and the sleep slot must each declare
  // a fixed inline width that does NOT depend on the variable-width content.
  // If those slots have stable widths, the arrows around them are pinned.
  describe('fixed nav slot widths (Mission 66)', () => {
    function findAgentInfoSlot(container: HTMLElement): HTMLElement {
      const slot = container.querySelector<HTMLElement>('[data-testid="review-agent-info-slot"]');
      if (!slot) throw new Error('agent info slot not found');
      return slot;
    }

    function findSleepSlot(container: HTMLElement): HTMLElement {
      const slot = container.querySelector<HTMLElement>('[data-testid="review-sleep-slot"]');
      if (!slot) throw new Error('sleep slot not found');
      return slot;
    }

    function findArrowOrder(container: HTMLElement): string[] {
      // Walk every focusable button in DOM order and emit a token per type so
      // we can compare structural ordering without relying on class strings.
      const buttons = Array.from(container.querySelectorAll('button'));
      return buttons.map((btn) => {
        const label = btn.getAttribute('aria-label') ?? '';
        if (label === 'Previous agent') return 'prev';
        if (label === 'Next agent') return 'next';
        if (label === 'Sleep agent') return 'sleep';
        if (label === 'Agent list') return 'jump';
        return 'other';
      });
    }

    it('agent info slot has identical width regardless of name length', () => {
      const short = renderBar({ agentName: 'a' });
      const longName = 'a-very-long-agent-name-that-changes-width';
      const long = renderBar({ agentName: longName });

      const w1 = findAgentInfoSlot(short.container).style.width;
      const w2 = findAgentInfoSlot(long.container).style.width;

      // Width must be set (not empty — a real fixed dimension)
      expect(w1).not.toBe('');
      // And it must be identical between the two renders
      expect(w1).toBe(w2);

      short.unmount();
      long.unmount();
    });

    it('sleep slot reserves identical width whether agent is running or not', () => {
      const running = renderBar({ isRunning: true });
      const notRunning = renderBar({ isRunning: false });

      const w1 = findSleepSlot(running.container).style.width;
      const w2 = findSleepSlot(notRunning.container).style.width;

      expect(w1).not.toBe('');
      expect(w1).toBe(w2);

      running.unmount();
      notRunning.unmount();
    });

    it('prev arrow appears before agent info, next arrow appears after agent info+sleep slot', () => {
      const { container } = renderBar({ isRunning: true });
      const order = findArrowOrder(container);

      // Structural assertion: prev → (no sleep yet) → next → sleep slot is
      // either between info and next OR adjacent to next, but the prev arrow
      // is always the first nav button and the next arrow is always before
      // any non-nav buttons (jump-list).
      const prevIdx = order.indexOf('prev');
      const nextIdx = order.indexOf('next');
      const jumpIdx = order.indexOf('jump');

      expect(prevIdx).toBeGreaterThanOrEqual(0);
      expect(nextIdx).toBeGreaterThan(prevIdx);
      expect(jumpIdx).toBeGreaterThan(nextIdx);
    });

    it('button order is identical for short and long agent names', () => {
      const short = renderBar({ agentName: 'a' });
      const long = renderBar({ agentName: 'a-very-long-agent-name-that-changes-width' });

      expect(findArrowOrder(short.container)).toEqual(findArrowOrder(long.container));

      short.unmount();
      long.unmount();
    });
  });
});

// ── Mission 66: index clamping for the case where the current agent is
// filtered out (e.g. user sleeps the last visible running agent). The bug
// was that `agents[currentIndex]` could be undefined for one render before
// a clamp useEffect ran, leading to a TypeError reading `.id`.
describe('clampIndex (Mission 66)', () => {
  it('returns 0 for an empty list', () => {
    expect(reviewModule.clampIndex(0, 0)).toBe(0);
    expect(reviewModule.clampIndex(5, 0)).toBe(0);
  });

  it('returns the index unchanged when within bounds', () => {
    expect(reviewModule.clampIndex(0, 5)).toBe(0);
    expect(reviewModule.clampIndex(2, 5)).toBe(2);
    expect(reviewModule.clampIndex(4, 5)).toBe(4);
  });

  it('clamps to length-1 when index is out of bounds high', () => {
    expect(reviewModule.clampIndex(5, 5)).toBe(4);
    expect(reviewModule.clampIndex(99, 3)).toBe(2);
  });

  it('clamps a negative index to 0', () => {
    expect(reviewModule.clampIndex(-1, 5)).toBe(0);
    expect(reviewModule.clampIndex(-10, 5)).toBe(0);
  });
});

describe('MainPanel sleep-last crash (Mission 66)', () => {
  function StubTerminal({ agentId }: { agentId: string }) {
    return React.createElement('div', { 'data-testid': `terminal-${agentId}` }, agentId);
  }
  function StubSleeping({ agentId }: { agentId: string }) {
    return React.createElement('div', { 'data-testid': `sleeping-${agentId}` }, agentId);
  }
  function StubAvatar({ agentId }: { agentId: string }) {
    return React.createElement('span', { 'data-testid': `avatar-${agentId}` }, agentId);
  }

  function makeStatefulApi(initial: AgentInfo[]): {
    api: PluginAPI;
    setList: (next: AgentInfo[]) => void;
  } {
    let list: AgentInfo[] = initial;
    const listeners = new Set<() => void>();

    const api = createMockAPI({
      context: { mode: 'app', projectId: 'p1', projectPath: '/tmp/p1' },
      agents: {
        list: () => list,
        createDurable: async () => '',
        runQuick: async () => '',
        kill: async () => {},
        resume: async () => {},
        listCompleted: () => [],
        dismissCompleted: () => {},
        getDetailedStatus: () => null,
        getModelOptions: async () => [{ id: 'default', label: 'Default' }],
        listOrchestrators: () => [],
        checkOrchestratorAvailability: async () => ({ available: false }),
        onStatusChange: () => ({ dispose: () => {} }),
        onAnyChange: (cb: () => void) => {
          listeners.add(cb);
          return { dispose: () => listeners.delete(cb) };
        },
        listSessions: async () => [],
        readSessionTranscript: async () => null,
        getSessionSummary: async () => null,
        spawnCompanion: (async () => {}) as unknown as PluginAPI['agents']['spawnCompanion'],
        getCompanionStatus: async () => 'none' as const,
        getCompanionWorkspace: (async () => {}) as unknown as PluginAPI['agents']['getCompanionWorkspace'],
      },
      widgets: {
        AgentTerminal: StubTerminal,
        SleepingAgent: StubSleeping,
        AgentAvatar: StubAvatar,
        QuickAgentGhost: (() => null) as unknown as PluginAPI['widgets']['QuickAgentGhost'],
      },
      settings: {
        get: <T>(key: string): T | undefined => {
          if (key === 'include-sleeping') return false as unknown as T;
          if (key === 'include-remote') return true as unknown as T;
          if (key === 'needs-attention-only') return false as unknown as T;
          return undefined;
        },
        getAll: () => ({}),
        set: () => {},
        onChange: () => ({ dispose: () => {} }),
      },
    });

    return {
      api,
      setList: (next: AgentInfo[]) => {
        list = next;
        listeners.forEach((cb) => cb());
      },
    };
  }

  it('does not crash when the currently selected last agent is filtered out', () => {
    const a1 = makeAgent({ id: 'a1', name: 'one', status: 'running' });
    const a2 = makeAgent({ id: 'a2', name: 'two', status: 'running' });
    const a3 = makeAgent({ id: 'a3', name: 'three', status: 'running' });
    const { api, setList } = makeStatefulApi([a1, a2, a3]);

    const { container, getAllByLabelText } = render(
      React.createElement(reviewModule.MainPanel, { api }),
    );

    // Navigate to the last visible agent (index 2). MainPanel renders two
    // "Next agent" buttons (the floating-bar chevron and the side arrow);
    // either one drives the same goNext callback.
    const nextBtn = getAllByLabelText('Next agent')[0];
    fireEvent.click(nextBtn);
    fireEvent.click(nextBtn);

    expect(container.querySelector('[data-testid="terminal-a3"]')).not.toBeNull();

    // Sleep the last agent: it transitions to sleeping. With include-sleeping
    // off, the filter removes it → length goes 3 → 2. Without the safeIndex
    // fix, the next render would read agents[2] = undefined and throw.
    expect(() => {
      act(() => {
        setList([a1, a2, { ...a3, status: 'sleeping' }]);
      });
    }).not.toThrow();

    // After clamping, render lands on the new last agent (a2)
    expect(container.querySelector('[data-testid="terminal-a2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-a3"]')).toBeNull();
  });

  it('renders EmptyState when the only visible agent is filtered out', () => {
    const a1 = makeAgent({ id: 'a1', name: 'only', status: 'running' });
    const { api, setList } = makeStatefulApi([a1]);

    const { container } = render(
      React.createElement(reviewModule.MainPanel, { api }),
    );

    expect(container.querySelector('[data-testid="terminal-a1"]')).not.toBeNull();

    expect(() => {
      act(() => {
        setList([{ ...a1, status: 'sleeping' }]);
      });
    }).not.toThrow();

    // Empty state has no agent terminal
    expect(container.querySelector('[data-testid="terminal-a1"]')).toBeNull();
    // The EmptyState text appears
    expect(container.textContent).toContain('No active agents');
  });
});
