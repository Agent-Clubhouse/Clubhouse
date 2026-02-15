import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MainPanel, activate, deactivate } from './main';
import { createMockAPI, createMockContext } from '../../testing';

function createAutomationsAPI(storageData: Record<string, unknown> = {}) {
  const storage: Record<string, unknown> = { ...storageData };

  return createMockAPI({
    storage: {
      ...createMockAPI().storage,
      projectLocal: {
        read: vi.fn(async (key: string) => storage[key]),
        write: vi.fn(async (key: string, value: unknown) => { storage[key] = value; }),
        delete: vi.fn(async (key: string) => { delete storage[key]; }),
        list: vi.fn(async () => Object.keys(storage)),
      },
    },
    agents: {
      ...createMockAPI().agents,
      getModelOptions: vi.fn(async () => [{ id: 'default', label: 'Default' }]),
      runQuick: vi.fn(async () => 'agent-1'),
      listCompleted: vi.fn(() => []),
    },
    ui: {
      ...createMockAPI().ui,
      showConfirm: vi.fn(async () => true),
    },
  });
}

describe('Automations MainPanel', () => {
  it('loading state before storage', () => {
    const api = createAutomationsAPI();
    render(<MainPanel api={api} />);
    expect(screen.getByText('Loading automations...')).toBeInTheDocument();
  });

  it('empty state when no automations', async () => {
    const api = createAutomationsAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('No automations yet')).toBeInTheDocument();
      expect(screen.getByText('Create an automation to get started')).toBeInTheDocument();
    });
  });

  it('create adds to sidebar', async () => {
    const api = createAutomationsAPI();
    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('+ Add')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('+ Add'));

    await waitFor(() => {
      expect(screen.getByText('New Automation')).toBeInTheDocument();
    });
  });

  it('select shows editor form', async () => {
    const automations = [
      {
        id: 'auto-1',
        name: 'Daily Cleanup',
        cronExpression: '0 9 * * *',
        model: '',
        prompt: 'Clean up logs',
        enabled: true,
        createdAt: Date.now(),
        lastRunAt: null,
      },
    ];
    const api = createAutomationsAPI({ automations });

    render(<MainPanel api={api} />);

    await waitFor(() => {
      expect(screen.getByText('Daily Cleanup')).toBeInTheDocument();
    });

    // Click to select
    fireEvent.click(screen.getByText('Daily Cleanup'));

    await waitFor(() => {
      // Editor should show with Name, Schedule, Model, Prompt labels
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Schedule')).toBeInTheDocument();
      expect(screen.getByText('Prompt')).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });
  });
});

describe('Automations activate/deactivate', () => {
  it('activate registers create command and sets up subscriptions', () => {
    const ctx = createMockContext();
    const api = createMockAPI();
    const registerSpy = vi.spyOn(api.commands, 'register');

    activate(ctx, api);

    expect(registerSpy).toHaveBeenCalledWith('create', expect.any(Function));
    // Should have at least 3 subscriptions: statusChange, cron interval, create command
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(3);
  });

  it('deactivate does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
