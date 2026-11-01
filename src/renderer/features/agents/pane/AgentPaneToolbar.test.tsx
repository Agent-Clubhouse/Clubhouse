import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { AgentPaneToolbar } from './AgentPaneToolbar';
import { chatActivity, chatUsage } from '../chat/ChatHeader';
import { createChatViewState } from '../../../stores/chatStore';
import type { Agent } from '../../../../shared/types';

const agent = { id: 'a1', name: 'gallant-swift', status: 'running', kind: 'durable', projectId: 'p1', color: 'indigo', orchestrator: 'claude-code' } as Agent;

/** Drives useNarrow's ResizeObserver from the test. */
function installResizeObserver() {
  let cb: ResizeObserverCallback | null = null;
  const Orig = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(c: ResizeObserverCallback) { cb = c; }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  return {
    resize: (width: number) => act(() => cb?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)),
    restore: () => { globalThis.ResizeObserver = Orig; },
  };
}

describe('AgentPaneToolbar', () => {
  let ro: ReturnType<typeof installResizeObserver> | null = null;
  afterEach(() => { ro?.restore(); ro = null; });

  it('is one 32px bar with status, activity, model, the details toggle and the switch, without the agent name', () => {
    render(
      <AgentPaneToolbar
        agent={agent}
        dot="working"
        activity="3:12 · Edit AgentRow.tsx"
        model="opus"
        runtime={{ value: 'chat', onChange: vi.fn() }}
        detailsToggle={<button type="button" data-testid="details-slot">Details</button>}
      />,
    );
    const bar = screen.getByTestId('agent-pane-toolbar');
    expect(bar.className).toContain('h-8');
    expect(bar).not.toHaveTextContent('gallant-swift');
    expect(screen.getByTestId('pane-status')).toHaveTextContent('Working');
    expect(screen.getByTestId('pane-activity')).toHaveTextContent('3:12 · Edit AgentRow.tsx');
    expect(screen.getByTestId('pane-model')).toHaveTextContent('opus');
    expect(screen.getByTestId('pane-orchestrator')).toHaveTextContent('C');
    expect(screen.getByTestId('details-slot')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
  });

  it('folds the switch and the model into icons below 640px', () => {
    ro = installResizeObserver();
    render(
      <AgentPaneToolbar agent={agent} dot="idle" model="opus" runtime={{ value: 'terminal', onChange: vi.fn() }} />,
    );
    ro.resize(400);
    expect(screen.getByTestId('agent-pane-toolbar')).toHaveAttribute('data-narrow', 'true');
    expect(screen.getByRole('radio', { name: 'CLI' })).toHaveTextContent('');
    expect(screen.queryByTestId('pane-model')).not.toBeInTheDocument();
    expect(screen.getByTestId('pane-orchestrator').getAttribute('aria-label')).toContain('Model opus');
    ro.resize(800);
    expect(screen.getByTestId('pane-model')).toHaveTextContent('opus');
  });

  it('keeps the toolbar glyph focusable with a provider tooltip', () => {
    render(<AgentPaneToolbar agent={agent} dot="idle" model="opus" />);
    const glyph = screen.getByTestId('pane-orchestrator');
    expect(glyph).toHaveAttribute('tabindex', '0');
    expect(glyph).toHaveClass('bg-surface-0');
    fireEvent.focus(glyph);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Claude Code');
  });

  it('offers the agent menu only where asked', () => {
    const { rerender } = render(<AgentPaneToolbar agent={agent} dot="idle" />);
    expect(screen.queryByTestId('pane-menu-button')).not.toBeInTheDocument();
    rerender(<AgentPaneToolbar agent={agent} dot="idle" showMenu />);
    fireEvent.click(screen.getByTestId('pane-menu-button'));
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
  });

  it('offers Changes as its own pressed button beside the Chat and CLI switch', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(<AgentPaneToolbar agent={agent} dot="idle" runtime={{ value: 'chat', onChange }} review={{ active: false, count: 6, onOpen, onClose }} />);
    const group = screen.getByRole('radiogroup', { name: 'Chat or CLI' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Chat', 'CLI']);
    expect(group).not.toContainElement(screen.getByTestId('view-changes'));
    const changes = screen.getByRole('button', { name: /Changes/ });
    expect(changes).toBe(screen.getByTestId('view-changes'));
    expect(changes).toHaveTextContent('Changes6');
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(changes);
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(<AgentPaneToolbar agent={agent} dot="idle" runtime={{ value: 'chat', onChange }} review={{ active: true, count: 6, onOpen, onClose }} />);
    expect(screen.getByTestId('view-changes')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'false');
    // Pressing it again returns to the last view without opening anything.
    fireEvent.click(screen.getByTestId('view-changes'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Back to the current runtime closes the review; the other runtime also switches.
    fireEvent.click(screen.getByRole('radio', { name: 'Chat' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'CLI' }));
    expect(onChange).toHaveBeenCalledWith('terminal');
  });

  it('keeps Changes as an icon button below 640px', () => {
    ro = installResizeObserver();
    render(<AgentPaneToolbar agent={agent} dot="idle" runtime={{ value: 'chat', onChange: vi.fn() }} review={{ active: true, count: 6, onOpen: vi.fn(), onClose: vi.fn() }} />);
    ro.resize(400);
    const changes = screen.getByRole('button', { name: 'Changes' });
    expect(changes).toHaveTextContent('');
    expect(changes).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows CLI and Changes for an agent that can\'t switch runtimes', () => {
    render(<AgentPaneToolbar agent={agent} dot="idle" runtime={{ value: 'terminal' }} review={{ active: false, onOpen: vi.fn(), onClose: vi.fn() }} />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['CLI']);
    expect(screen.getByTestId('view-changes')).toHaveTextContent('Changes');
  });

  it('names the agent only when asked (the classic shell)', () => {
    const { rerender } = render(<AgentPaneToolbar agent={agent} dot="idle" />);
    expect(screen.queryByTestId('pane-agent-name')).not.toBeInTheDocument();
    rerender(<AgentPaneToolbar agent={agent} dot="idle" showName />);
    expect(screen.getByTestId('pane-agent-name')).toHaveTextContent('gallant-swift');
    // In a narrow pane the activity gives way first; the name keeps up to 40% and shows whole on hover.
    expect(screen.getByTestId('pane-agent-name').className).toMatch(/\bflex-shrink-0\b/);
    expect(screen.getByTestId('pane-agent-name')).toHaveAttribute('title', 'gallant-swift');
  });

  it('shows a focusable meter: blue context, amber limit, red when one runs out', () => {
    const lines = ['Context 34%: 68k of 200k tokens', 'Session (5-hour) limit: 40%, resets Fri 3:00 PM'];
    const { rerender } = render(<AgentPaneToolbar agent={agent} dot="working" usage={{ fillPct: 34, text: '34%', label: 'Context 34%', tone: 'normal', lines }} />);
    const meter = screen.getByTestId('pane-usage');
    expect(meter).toHaveTextContent('34%');
    expect(meter).toHaveAttribute('tabindex', '0');
    // The label isn't repeated: the context line is dropped from the list.
    expect(meter.getAttribute('aria-label')).toBe(`Context 34%, ${lines[1]}`);
    expect(meter).not.toHaveAttribute('data-hot');
    expect(screen.getByTestId('pane-usage-fill').getAttribute('class')).toContain('stroke-ctp-info');
    rerender(<AgentPaneToolbar agent={agent} dot="working" usage={{ fillPct: 71, text: '71% wk', label: 'Weekly limit 71%', tone: 'warn', lines }} />);
    expect(screen.getByTestId('pane-usage')).toHaveTextContent('71% wk');
    expect(screen.getByTestId('pane-usage').className).toContain('text-ctp-warning');
    expect(screen.getByTestId('pane-usage-fill').getAttribute('class')).toContain('stroke-ctp-warning');
    rerender(<AgentPaneToolbar agent={agent} dot="working" usage={{ fillPct: 92, text: '92%', label: 'Context 92%', tone: 'hot', lines: [] }} />);
    expect(screen.getByTestId('pane-usage')).toHaveAttribute('data-hot', 'true');
    expect(screen.getByTestId('pane-usage').className).toContain('text-ctp-error');
    rerender(<AgentPaneToolbar agent={agent} dot="working" usage={{ fillPct: null, text: null, label: 'Usage limits', tone: 'normal', lines: [] }} />);
    expect(screen.queryByTestId('pane-usage-fill')).toBeNull();
  });
});

describe('chatActivity', () => {
  const base = createChatViewState('a1');
  it('shows elapsed time and the running tool', () => {
    const state = {
      ...base, state: 'running' as const, turnStartedAt: 0,
      items: [{ id: 't', sessionId: 's', seq: 1, ts: 0, kind: 'tool_call' as const, toolCallId: 't', toolKind: 'edit' as const, title: 'Edit AgentRow.tsx', status: 'in_progress' as const, content: [] }],
    };
    expect(chatActivity(state, 192_000)).toBe('3:12 · Edit AgentRow.tsx');
  });
  it('says when the context is compacting, in a turn or idle', () => {
    const row = { id: 'n', sessionId: 's', seq: 1, ts: 0, kind: 'notice' as const, level: 'info' as const, code: 'compaction_in_progress', message: 'Compacting context…', running: true };
    expect(chatActivity({ ...base, state: 'running', turnStartedAt: 0, items: [row], compactionItemId: 'n' }, 85_000)).toBe('1:25 · Compacting context');
    expect(chatActivity({ ...base, state: 'idle', items: [row], compactionItemId: 'n' }, 0)).toBe('Compacting context');
  });
  describe('chatUsage', () => {
    const caps = { usage: 'tokens', limits: true } as never;
    const at = (context: { used: number; size: number } | null, limits: unknown[]) =>
      chatUsage({ ...base, capabilities: caps, usage: { ...base.usage, context, limits } as never });

    it('shows context, red at 90%', () => {
      expect(at({ used: 42, size: 100 }, [{ window: 'week', utilization: 0.5 }])).toMatchObject({ fillPct: 42, text: '42%', tone: 'normal' });
      expect(at({ used: 95, size: 100 }, [])).toMatchObject({ fillPct: 95, tone: 'hot' });
    });

    it('fills from the most-used limit when there is no context', () => {
      const u = at(null, [{ window: '5h', utilization: 0.2 }, { window: 'week', utilization: 0.55 }]);
      expect(u).toMatchObject({ fillPct: 55, text: '55% wk', label: 'Weekly limit 55%', tone: 'normal' });
    });

    it('keeps showing context when a limit is at warning, tinted amber, with the limit in the tooltip', () => {
      const u = at({ used: 10, size: 100 }, [{ window: '5h', utilization: 0.3 }, { window: 'week', utilization: 0.71, status: 'warning', resetsAt: Date.parse('2026-10-21T09:00:00Z') }]);
      expect(u).toMatchObject({ fillPct: 10, text: '10%', tone: 'warn' });
      expect(u?.lines[0]).toBe('Context 10%: 10 of 100 tokens');
      expect(u?.lines[1]).toBe('Session (5-hour) limit: 30%');
      expect(u?.lines[2]).toMatch(/^Weekly limit: 71%, resets /);
      // 80% used counts as a warning when the provider reports only a fraction (Codex).
      expect(at({ used: 10, size: 100 }, [{ window: '5h', utilization: 0.85 }])).toMatchObject({ text: '10%', tone: 'warn' });
      // With no context to show, the warning limit takes the ring.
      expect(at(null, [{ window: 'week', utilization: 0.71, status: 'warning' }])).toMatchObject({ fillPct: 71, text: '71% wk', tone: 'warn' });
    });

    it('turns red when a limit is reached, and names a status-only limit', () => {
      const u = at({ used: 10, size: 100 }, [{ window: '5h', status: 'exceeded', resetsAt: Date.parse('2026-10-17T15:00:00Z') }]);
      expect(u).toMatchObject({ fillPct: 10, text: 'limit reached 5h', tone: 'hot' });
      expect(u?.lines[1]).toMatch(/^Session \(5-hour\) limit: limit reached, resets /);
      expect(at(null, [{ window: 'week_opus', status: 'ok' }])).toMatchObject({ fillPct: null, text: null, tone: 'normal' });
      expect(at(null, [{ window: 'week:Fable', utilization: 0.4 }])).toMatchObject({ text: '40% wk Fable', label: 'Weekly Fable limit 40%' });
      expect(chatUsage({ ...base, capabilities: { usage: 'none' } as never })).toBeNull();
    });
  });

  it('says what a waiting agent needs', () => {
    expect(chatActivity({ ...base, state: 'waiting_input' }, 0)).toBe('Has a question');
    expect(chatActivity({ ...base, state: 'idle' }, 0)).toBe('');
  });
});
