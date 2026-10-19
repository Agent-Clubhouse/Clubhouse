import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentSettingsNav } from './AgentSettingsNav';
import { hiddenAgentSettingsPages, useAgentSettingsPages } from '../../features/agents/agentSettingsPages';

beforeEach(() => {
  useAgentSettingsPages.getState().reset();
});

describe('AgentSettingsNav', () => {
  it('lists the pages in order with General selected', () => {
    render(<AgentSettingsNav />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual([
      'General', 'Instructions', 'Skills', 'Agent definitions', 'MCP servers', 'Permissions', 'Helpers', 'Quick agents', 'Shell in worktree',
    ]);
    expect(screen.getByTestId('agent-settings-nav-general').getAttribute('aria-current')).toBe('page');
  });

  it('leaves out hidden pages and moves off one that was selected (#2232)', () => {
    render(<AgentSettingsNav />);
    act(() => { useAgentSettingsPages.getState().setPage('helpers'); });
    act(() => { useAgentSettingsPages.getState().setHiddenPages(['helpers']); });
    expect(screen.queryByTestId('agent-settings-nav-helpers')).toBeNull();
    expect(useAgentSettingsPages.getState().page).toBe('general');
  });

  it('hides Helpers for a helper and for a remote agent', () => {
    expect(hiddenAgentSettingsPages({ projectId: 'p1' }, false)).toEqual([]);
    expect(hiddenAgentSettingsPages({ projectId: 'p1', parentAgentId: 'lead' }, false)).toEqual(['helpers']);
    expect(hiddenAgentSettingsPages({ projectId: 'remote||sat||p1' }, true)).toEqual(['helpers']);
  });

  it('selects a page', () => {
    render(<AgentSettingsNav />);
    fireEvent.click(screen.getByTestId('agent-settings-nav-permissions'));
    expect(useAgentSettingsPages.getState().page).toBe('permissions');
    expect(screen.getByTestId('agent-settings-nav-permissions').getAttribute('aria-current')).toBe('page');
  });

  it('marks pages with unsaved edits and shows counts on the others', () => {
    render(<AgentSettingsNav />);
    act(() => {
      useAgentSettingsPages.getState().setDirtyPages(['instructions']);
      useAgentSettingsPages.getState().setCount('skills', 3);
    });
    expect(screen.getByTestId('agent-settings-nav-instructions').querySelector('[aria-label="Unsaved changes"]')).toBeTruthy();
    expect(screen.getByTestId('agent-settings-nav-skills').textContent).toBe('Skills3');
    expect(screen.getByTestId('agent-settings-nav-general').querySelector('[aria-label="Unsaved changes"]')).toBeNull();
  });

  it('toggles the shell in worktree', () => {
    render(<AgentSettingsNav />);
    const row = screen.getByTestId('agent-settings-nav-shell');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(row);
    expect(useAgentSettingsPages.getState().shellOpen).toBe(true);
    expect(row.getAttribute('aria-pressed')).toBe('true');
  });
});
