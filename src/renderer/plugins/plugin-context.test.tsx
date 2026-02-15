import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginAPIProvider, usePluginAPI } from './plugin-context';
import { createMockAPI } from './testing';

function Consumer() {
  const api = usePluginAPI();
  return <div data-testid="project-path">{api.project.projectPath}</div>;
}

describe('PluginAPIProvider / usePluginAPI', () => {
  it('usePluginAPI() returns the provided API', () => {
    const api = createMockAPI();
    render(
      <PluginAPIProvider api={api}>
        <Consumer />
      </PluginAPIProvider>,
    );
    expect(screen.getByTestId('project-path').textContent).toBe('/tmp/test-project');
  });

  it('usePluginAPI() throws outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(
      'usePluginAPI must be used within a <PluginAPIProvider>',
    );
    spy.mockRestore();
  });

  it('nested providers — inner wins', () => {
    const outer = createMockAPI({ project: { ...createMockAPI().project, projectPath: '/outer' } });
    const inner = createMockAPI({ project: { ...createMockAPI().project, projectPath: '/inner' } });

    render(
      <PluginAPIProvider api={outer}>
        <PluginAPIProvider api={inner}>
          <Consumer />
        </PluginAPIProvider>
      </PluginAPIProvider>,
    );

    expect(screen.getByTestId('project-path').textContent).toBe('/inner');
  });

  it('API reference stability across re-renders', () => {
    const api = createMockAPI();
    const refs: unknown[] = [];

    function Collector() {
      const a = usePluginAPI();
      refs.push(a);
      return null;
    }

    const { rerender } = render(
      <PluginAPIProvider api={api}>
        <Collector />
      </PluginAPIProvider>,
    );

    rerender(
      <PluginAPIProvider api={api}>
        <Collector />
      </PluginAPIProvider>,
    );

    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(refs[1]);
  });
});
