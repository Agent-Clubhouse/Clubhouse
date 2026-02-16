import React, { useEffect, useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { vi } from 'vitest';
import { PluginAPIProvider, usePluginAPI } from './plugin-context';
import { createMockAPI } from './testing';
import type { PluginAPI } from '../../shared/plugin-types';

/** Thin canary component that exercises one API namespace and shows the result. */
function Canary({ use }: { use: (api: PluginAPI) => Promise<string> | string }) {
  const api = usePluginAPI();
  const [result, setResult] = useState('pending');

  useEffect(() => {
    const r = use(api);
    if (r instanceof Promise) {
      r.then((v) => setResult(v)).catch((e) => setResult(`error: ${e}`));
    } else {
      setResult(r);
    }
  }, [api, use]);

  return <div data-testid="result">{result}</div>;
}

function renderCanary(
  use: (api: PluginAPI) => Promise<string> | string,
  apiOverrides?: Partial<PluginAPI>,
) {
  const api = createMockAPI(apiOverrides);
  return render(
    <PluginAPIProvider api={api}>
      <Canary use={use} />
    </PluginAPIProvider>,
  );
}

describe('Plugin API v0.4.0 canary tests', () => {
  it('api.project.readTree() renders result', async () => {
    renderCanary(
      async (api) => {
        const entries = await api.project.listDirectory();
        return `entries: ${entries.length}`;
      },
    );
    expect(await screen.findByText('entries: 0')).toBeInTheDocument();
  });

  it('api.git.currentBranch() renders result', async () => {
    renderCanary(async (api) => {
      const branch = await api.git.currentBranch();
      return `branch: ${branch}`;
    });
    expect(await screen.findByText('branch: main')).toBeInTheDocument();
  });

  it('api.storage.projectLocal.read() renders result', async () => {
    renderCanary(
      async (api) => {
        const val = await api.storage.projectLocal.read('key');
        return `val: ${String(val)}`;
      },
    );
    expect(await screen.findByText('val: undefined')).toBeInTheDocument();
  });

  it('api.events.on(...) receives event', async () => {
    let handler: ((...args: unknown[]) => void) | undefined;
    const api = createMockAPI({
      events: {
        on: (event: string, h: (...args: unknown[]) => void) => {
          handler = h;
          return { dispose: () => {} };
        },
      },
    });

    function EventCanary() {
      const a = usePluginAPI();
      const [received, setReceived] = useState('waiting');
      useEffect(() => {
        const sub = a.events.on('test', (data: unknown) => setReceived(String(data)));
        return () => sub.dispose();
      }, [a]);
      return <div data-testid="result">{received}</div>;
    }

    render(
      <PluginAPIProvider api={api}>
        <EventCanary />
      </PluginAPIProvider>,
    );

    expect(screen.getByTestId('result').textContent).toBe('waiting');

    act(() => {
      handler?.('hello');
    });

    expect(screen.getByTestId('result').textContent).toBe('hello');
  });

  it('api.commands.register(...) returns disposable', () => {
    const api = createMockAPI();
    const disposable = api.commands.register('test-cmd', () => {});
    expect(typeof disposable.dispose).toBe('function');
    expect(() => disposable.dispose()).not.toThrow();
  });

  it('api.ui.showNotice(...) callable', () => {
    const api = createMockAPI();
    expect(() => api.ui.showNotice('Test notice')).not.toThrow();
  });

  it('api.agents.list() renders result', async () => {
    renderCanary((api) => {
      const agents = api.agents.list();
      return `agents: ${agents.length}`;
    });
    expect(await screen.findByText('agents: 0')).toBeInTheDocument();
  });

  it('api.navigation.focusAgent(...) callable', () => {
    const api = createMockAPI();
    expect(() => api.navigation.focusAgent('agent-1')).not.toThrow();
  });

  it('api.terminal.spawn(...) callable', async () => {
    const api = createMockAPI();
    await expect(api.terminal.spawn('session-1')).resolves.not.toThrow();
  });

  it('api.widgets.AgentTerminal is a component', () => {
    const api = createMockAPI();
    expect(api.widgets.AgentTerminal).toBeDefined();
    expect(typeof api.widgets.AgentTerminal).toBe('function');
  });

  it('api.logging.info(...) callable', () => {
    const api = createMockAPI();
    expect(() => api.logging.info('test message')).not.toThrow();
    expect(() => api.logging.info('test', { key: 'value' })).not.toThrow();
  });

  it('api.files.readTree(...) renders result', async () => {
    renderCanary(async (api) => {
      const nodes = await api.files.readTree();
      return `nodes: ${nodes.length}`;
    });
    expect(await screen.findByText('nodes: 0')).toBeInTheDocument();
  });

  it('api.context.mode readable', () => {
    const api = createMockAPI();
    expect(api.context.mode).toBe('project');
    expect(api.context.projectId).toBe('test-project');
    expect(api.context.projectPath).toBe('/tmp/test-project');
  });
});

describe('Plugin API v0.5.0 canary tests', () => {
  it('api.files.forRoot exists as a function', () => {
    const api = createMockAPI();
    expect(typeof api.files.forRoot).toBe('function');
  });

  it('api.files.forRoot throws in stub (no real external root)', () => {
    const api = createMockAPI();
    expect(() => api.files.forRoot('wiki')).toThrow();
  });

  it('api.files.forRoot can be overridden in mock', () => {
    const mockForRoot = vi.fn(() => createMockAPI().files);
    const api = createMockAPI({
      files: {
        ...createMockAPI().files,
        forRoot: mockForRoot,
      },
    });
    const extFiles = api.files.forRoot('wiki');
    expect(mockForRoot).toHaveBeenCalledWith('wiki');
    expect(typeof extFiles.readFile).toBe('function');
  });

  it('permission-denied APIs surface exists in PluginAPI type', () => {
    // Canary: these are the APIs that v0.5 gates behind permissions.
    // They should all be defined on the mock (v0.4 compat).
    const api = createMockAPI();
    const gatedSurfaces: (keyof PluginAPI)[] = [
      'project', 'projects', 'git', 'storage', 'ui', 'commands',
      'events', 'agents', 'navigation', 'widgets', 'terminal',
      'logging', 'files', 'voice', 'github',
    ];
    for (const key of gatedSurfaces) {
      expect(api[key]).toBeDefined();
    }
  });

  it('always-available APIs remain accessible', () => {
    const api = createMockAPI();
    // context, settings, hub are never gated
    expect(api.context.mode).toBe('project');
    expect(typeof api.settings.get).toBe('function');
    expect(typeof api.hub.refresh).toBe('function');
  });
});
