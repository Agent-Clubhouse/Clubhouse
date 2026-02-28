import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { SettingsMonacoEditor } from './SettingsMonacoEditor';

// Mock themes to avoid require issues in jsdom
vi.mock('../themes/index', () => ({
  THEMES: { 'catppuccin-mocha': { name: 'Mocha', colors: {} } },
}));

vi.mock('../plugins/builtin/files/monaco-theme', () => ({
  generateMonacoTheme: () => ({ base: 'vs-dark', inherit: true, rules: [], colors: {} }),
}));

vi.mock('../stores/themeStore', () => ({
  useThemeStore: (sel: (s: { themeId: string }) => string) => sel({ themeId: 'catppuccin-mocha' }),
}));

describe('SettingsMonacoEditor lazy loading', () => {
  it('shows loading indicator then renders editor', async () => {
    render(
      <SettingsMonacoEditor
        value='{"key": "value"}'
        language="json"
        onChange={() => {}}
      />,
    );

    // Loading indicator should appear initially
    expect(screen.getByText('Loading editor…')).toBeInTheDocument();

    // After async import resolves, loading indicator should disappear
    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });
  });

  it('disposes editor on unmount', async () => {
    const { unmount } = render(
      <SettingsMonacoEditor
        value="test"
        language="markdown"
        onChange={() => {}}
      />,
    );

    // Wait for editor to load
    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    // Should not throw on unmount
    expect(() => unmount()).not.toThrow();
  });

  it('respects custom height prop', async () => {
    const { container } = render(
      <SettingsMonacoEditor
        value=""
        language="json"
        onChange={() => {}}
        height="400px"
      />,
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.height).toBe('400px');

    // Wait for async effects to settle to avoid act() warnings
    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });
  });
});
