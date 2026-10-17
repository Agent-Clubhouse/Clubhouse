import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentPaneToolbar } from './AgentPaneToolbar';
import { chatActivity } from '../chat/ChatHeader';
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

  it('is one 32px bar with status, activity, model, Changes and the switch, without the agent name', () => {
    const onToggle = vi.fn();
    render(
      <AgentPaneToolbar
        agent={agent}
        dot="working"
        activity="3:12 · Edit AgentRow.tsx"
        model="opus"
        changes={{ open: false, onToggle }}
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
    fireEvent.click(screen.getByTestId('chat-changes-toggle'));
    expect(onToggle).toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true');
  });

  it('folds Changes, the switch and the model into icons below 640px', () => {
    ro = installResizeObserver();
    render(
      <AgentPaneToolbar agent={agent} dot="idle" model="opus" changes={{ open: false, onToggle: vi.fn() }} runtime={{ value: 'terminal', onChange: vi.fn() }} />,
    );
    ro.resize(400);
    expect(screen.getByTestId('agent-pane-toolbar')).toHaveAttribute('data-narrow', 'true');
    expect(screen.getByTestId('chat-changes-toggle')).toHaveAttribute('aria-label', 'Changes');
    expect(screen.getByTestId('chat-changes-toggle')).toHaveTextContent('');
    expect(screen.getByRole('radio', { name: 'Terminal' })).toHaveTextContent('');
    expect(screen.queryByTestId('pane-model')).not.toBeInTheDocument();
    expect(screen.getByTestId('pane-orchestrator').getAttribute('title')).toContain('Model opus');
    ro.resize(800);
    expect(screen.getByTestId('pane-model')).toHaveTextContent('opus');
  });

  it('opens the agent menu from the toolbar', () => {
    const handler = vi.fn();
    render(<AgentPaneToolbar agent={agent} dot="idle" actions={[{ id: 'popout', label: 'Pop out', icon: null, hoverColor: '', visible: true, handler }]} />);
    fireEvent.click(screen.getByTestId('pane-menu-button'));
    fireEvent.click(screen.getByTestId('ctx-popout'));
    expect(handler).toHaveBeenCalled();
  });

  it('hides the menu when there are no actions', () => {
    render(<AgentPaneToolbar agent={agent} dot="idle" />);
    expect(screen.queryByTestId('pane-menu-button')).not.toBeInTheDocument();
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
  it('says what a waiting agent needs', () => {
    expect(chatActivity({ ...base, state: 'waiting_input' }, 0)).toBe('Has a question');
    expect(chatActivity({ ...base, state: 'idle' }, 0)).toBe('');
  });
});
