import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MonacoEditor } from './MonacoEditor';

// Mock themes to avoid require issues in jsdom
vi.mock('../../../themes/index', () => ({
  THEMES: { 'catppuccin-mocha': { name: 'Mocha', colors: {} } },
}));

vi.mock('./monaco-theme', () => ({
  generateMonacoTheme: () => ({ base: 'vs-dark', inherit: true, rules: [], colors: {} }),
}));

vi.mock('../../../stores/themeStore', () => ({
  useThemeStore: (sel: (s: { themeId: string }) => string) => sel({ themeId: 'catppuccin-mocha' }),
}));

describe('MonacoEditor lazy loading', () => {
  it('shows loading indicator then renders editor', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
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
      <MonacoEditor
        value="test"
        language="javascript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.js"
      />,
    );

    // Wait for editor to load
    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    // Should not throw on unmount
    expect(() => unmount()).not.toThrow();
  });
});
