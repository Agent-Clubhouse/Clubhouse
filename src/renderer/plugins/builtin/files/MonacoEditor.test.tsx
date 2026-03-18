import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MonacoEditor, handleMonacoEditCommand } from './MonacoEditor';
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
    expect(addCommandCalls.length).toBeGreaterThanOrEqual(9); // Save + 7 find/replace + 1 word wrap

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

describe('MonacoEditor word wrap toggle', () => {
  it('registers Alt+Z keybinding for word wrap toggle', async () => {
    render(
      <MonacoEditor
        value="line one\nline two\nline three"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();
    const addCommandCalls = mockEditorInstance.addCommand.mock.calls;
    const registeredBindings = addCommandCalls.map((call: any[]) => call[0]);

    // Alt+Z — word wrap toggle
    expect(registeredBindings).toContain(KeyMod.Alt | KeyCode.KeyZ);
  });

  it('toggles word wrap on/off when Alt+Z callback is invoked', async () => {
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
    const addCommandCalls = mockEditorInstance.addCommand.mock.calls;

    const wordWrapBinding = KeyMod.Alt | KeyCode.KeyZ;
    const wordWrapCall = addCommandCalls.find((call: any[]) => call[0] === wordWrapBinding);
    expect(wordWrapCall).toBeDefined();

    // First invoke: should enable word wrap
    wordWrapCall[1]();
    expect(mockEditorInstance.updateOptions).toHaveBeenCalledWith({ wordWrap: 'on' });

    // Second invoke: should disable word wrap
    wordWrapCall[1]();
    expect(mockEditorInstance.updateOptions).toHaveBeenCalledWith({ wordWrap: 'off' });
  });
});

describe('handleMonacoEditCommand', () => {
  it('returns false when no Monaco module is loaded', () => {
    // Before any editor is rendered, monacoModule is null
    // handleMonacoEditCommand should safely return false
    expect(handleMonacoEditCommand('selectAll')).toBe(false);
  });

  it('dispatches selectAll to focused Monaco editor', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();

    // Simulate editor having focus
    mockEditorInstance.hasTextFocus.mockReturnValue(true);

    expect(handleMonacoEditCommand('selectAll')).toBe(true);
    expect(mockEditorInstance.trigger).toHaveBeenCalledWith('menu', 'editor.action.selectAll', null);
  });

  it('dispatches copy to focused Monaco editor', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();
    mockEditorInstance.hasTextFocus.mockReturnValue(true);

    expect(handleMonacoEditCommand('copy')).toBe(true);
    expect(mockEditorInstance.trigger).toHaveBeenCalledWith('menu', 'editor.action.clipboardCopyAction', null);
  });

  it('returns false when no editor has focus', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();
    mockEditorInstance.hasTextFocus.mockReturnValue(false);

    expect(handleMonacoEditCommand('selectAll')).toBe(false);
  });

  it('returns false for unknown command', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const mockEditorInstance = (monaco.editor.create as any)();
    mockEditorInstance.hasTextFocus.mockReturnValue(true);

    expect(handleMonacoEditCommand('unknownCommand')).toBe(false);
  });
});

describe('MonacoEditor enhanced options', () => {
  it('creates editor with minimap enabled', async () => {
    render(
      <MonacoEditor
        value="hello"
        language="typescript"
        onSave={() => {}}
        onDirtyChange={() => {}}
        filePath="test.ts"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading editor…')).not.toBeInTheDocument();
    });

    const monaco = await import('monaco-editor');
    const createCalls = (monaco.editor.create as any).mock?.calls;
    if (createCalls && createCalls.length > 0) {
      const options = createCalls[createCalls.length - 1][1];
      expect(options.minimap?.enabled).toBe(true);
      expect(options.stickyScroll?.enabled).toBe(true);
      expect(options.guides?.indentation).toBe(true);
      expect(options.cursorSmoothCaretAnimation).toBe('on');
    }
  });
});
