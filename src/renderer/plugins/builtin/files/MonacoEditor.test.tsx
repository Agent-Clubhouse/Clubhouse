import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MonacoEditor } from './MonacoEditor';
import { KeyMod, KeyCode } from 'monaco-editor';

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
        initialScrollState={null}
        onScrollStateChange={() => {}}
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
        initialScrollState={null}
        onScrollStateChange={() => {}}
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

describe('MonacoEditor find/replace keybindings', () => {
  it('registers find and replace keybindings on editor', async () => {
    render(
      <MonacoEditor
        value="hello world"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    // Access the mock's addCommand calls
    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();

    // Verify addCommand was called with keybinding constants for find/replace
    const addCommandCalls = mockEditorInstance.addCommand.mock.calls;
    expect(addCommandCalls.length).toBeGreaterThanOrEqual(8); // Save + 7 find/replace bindings

    // Collect all registered keybindings
    const registeredBindings = addCommandCalls.map((call: any[]) => call[0]);

    // Cmd+F — find
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyCode.KeyF);
    // Cmd+H — find and replace
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyCode.KeyH);
    // Cmd+Option+F — find and replace (alternative)
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF);
    // Cmd+G — next match
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyCode.KeyG);
    // Cmd+Shift+G — previous match
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyG);
    // Cmd+D — add selection to next find match
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyCode.KeyD);
    // Cmd+Shift+L — select all occurrences
    expect(registeredBindings).toContain(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyL);
  });

  it('invokes correct editor trigger actions for find keybindings', async () => {
    render(
      <MonacoEditor
        value="test content"
        language="javascript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.js"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();

    // Find the callback for Cmd+F and invoke it
    const addCommandCalls = mockEditorInstance.addCommand.mock.calls;
    const findBinding = KeyMod.CtrlCmd | KeyCode.KeyF;
    const findCall = addCommandCalls.find((call: any[]) => call[0] === findBinding);
    expect(findCall).toBeDefined();

    // Execute the callback
    findCall[1]();

    // Verify trigger was called with the find action
    expect(mockEditorInstance.trigger).toHaveBeenCalledWith('keyboard', 'actions.find', null);

    // Find the callback for Cmd+H and invoke it
    const replaceBinding = KeyMod.CtrlCmd | KeyCode.KeyH;
    const replaceCall = addCommandCalls.find((call: any[]) => call[0] === replaceBinding);
    expect(replaceCall).toBeDefined();

    replaceCall[1]();
    expect(mockEditorInstance.trigger).toHaveBeenCalledWith(
      'keyboard',
      'editor.action.startFindReplaceAction',
      null,
    );
  });
});
