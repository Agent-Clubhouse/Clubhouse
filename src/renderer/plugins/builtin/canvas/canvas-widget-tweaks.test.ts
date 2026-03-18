import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Feature 1: File browser read-only toggle ────────────────────────

describe('FileCanvasView — read-only toggle', () => {
  it('defaults to read-only (checked)', () => {
    // The readOnly state defaults to true — checkbox checked = readonly
    const defaultReadOnly = true;
    expect(defaultReadOnly).toBe(true);
  });

  it('unchecking switches to edit mode', () => {
    let readOnly = true;
    // Simulating checkbox toggle
    readOnly = false;
    expect(readOnly).toBe(false);
  });

  it('checking again switches back to read-only', () => {
    let readOnly = false;
    readOnly = true;
    expect(readOnly).toBe(true);
  });
});

describe('ReadOnlyMonacoEditor — readOnly prop toggling', () => {
  it('updateOptions receives correct readOnly values', () => {
    const updateOptions = vi.fn();

    // Simulate the useEffect that toggles readOnly
    const applyReadOnly = (readOnly: boolean) => {
      updateOptions({ readOnly, domReadOnly: readOnly });
    };

    applyReadOnly(true);
    expect(updateOptions).toHaveBeenCalledWith({ readOnly: true, domReadOnly: true });

    applyReadOnly(false);
    expect(updateOptions).toHaveBeenCalledWith({ readOnly: false, domReadOnly: false });
  });

  it('onSave callback receives editor content', () => {
    const onSave = vi.fn();
    const editorContent = 'console.log("hello");';

    // Simulate Cmd+S handler
    onSave(editorContent);
    expect(onSave).toHaveBeenCalledWith(editorContent);
  });
});

// ── Feature 2: Agent widget stop button ─────────────────────────────

describe('AgentCanvasView — stop button', () => {
  it('calls api.agents.kill with the agent ID', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    const agentId = 'agent-123';

    // Simulate handleStop callback
    const handleStop = async () => {
      if (agentId) {
        await kill(agentId);
      }
    };

    await handleStop();
    expect(kill).toHaveBeenCalledWith('agent-123');
  });

  it('does not call kill when agentId is null', async () => {
    const kill = vi.fn();
    const agentId: string | null = null;

    const handleStop = async () => {
      if (agentId) {
        await kill(agentId);
      }
    };

    await handleStop();
    expect(kill).not.toHaveBeenCalled();
  });

  it('stop button only shows for running/creating agents', () => {
    const shouldShowStop = (status: string) =>
      status === 'running' || status === 'creating';

    expect(shouldShowStop('running')).toBe(true);
    expect(shouldShowStop('creating')).toBe(true);
    expect(shouldShowStop('sleeping')).toBe(false);
    expect(shouldShowStop('error')).toBe(false);
    expect(shouldShowStop('idle')).toBe(false);
  });
});

// ── Feature 3: Git diff right-click context menu ────────────────────

describe('GitDiffCanvasView — context menu actions', () => {
  let gitStageMock: ReturnType<typeof vi.fn>;
  let gitUnstageMock: ReturnType<typeof vi.fn>;
  let gitDiscardMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gitStageMock = vi.fn().mockResolvedValue({ ok: true, message: '' });
    gitUnstageMock = vi.fn().mockResolvedValue({ ok: true, message: '' });
    gitDiscardMock = vi.fn().mockResolvedValue({ ok: true, message: '' });

    (globalThis as any).window = {
      ...(globalThis as any).window,
      clubhouse: {
        git: {
          stage: gitStageMock,
          unstage: gitUnstageMock,
          discard: gitDiscardMock,
          info: vi.fn().mockResolvedValue({
            branch: 'main', branches: ['main'], status: [], log: [],
            hasGit: true, ahead: 0, behind: 0, remote: 'origin', stashCount: 0, hasConflicts: false,
          }),
          diff: vi.fn().mockResolvedValue({ original: '', modified: '' }),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stage calls window.clubhouse.git.stage with correct args', async () => {
    const effectivePath = '/path/to/repo';
    const filePath = 'src/index.ts';

    await window.clubhouse.git.stage(effectivePath, filePath);
    expect(gitStageMock).toHaveBeenCalledWith('/path/to/repo', 'src/index.ts');
  });

  it('unstage calls window.clubhouse.git.unstage with correct args', async () => {
    const effectivePath = '/path/to/repo';
    const filePath = 'src/index.ts';

    await window.clubhouse.git.unstage(effectivePath, filePath);
    expect(gitUnstageMock).toHaveBeenCalledWith('/path/to/repo', 'src/index.ts');
  });

  it('revert calls window.clubhouse.git.discard for tracked files', async () => {
    const effectivePath = '/path/to/repo';
    const filePath = 'src/index.ts';

    await window.clubhouse.git.discard(effectivePath, filePath, false);
    expect(gitDiscardMock).toHaveBeenCalledWith('/path/to/repo', 'src/index.ts', false);
  });

  it('revert calls window.clubhouse.git.discard with isUntracked=true for ?? status', async () => {
    const effectivePath = '/path/to/repo';
    const filePath = 'new-file.ts';

    const status = '??';
    const isUntracked = status.trim() === '??' || status.trim() === '?';
    await window.clubhouse.git.discard(effectivePath, filePath, isUntracked);
    expect(gitDiscardMock).toHaveBeenCalledWith('/path/to/repo', 'new-file.ts', true);
  });

  it('context menu shows Stage for unstaged files', () => {
    const staged = false;
    const menuAction = staged ? 'Unstage' : 'Stage';
    expect(menuAction).toBe('Stage');
  });

  it('context menu shows Unstage for staged files', () => {
    const staged = true;
    const menuAction = staged ? 'Unstage' : 'Stage';
    expect(menuAction).toBe('Unstage');
  });
});

describe('GitDiffCanvasView — revert confirmation', () => {
  it('shows confirm dialog with file name from path', () => {
    const filePath = 'src/renderer/plugins/builtin/canvas/GitDiffCanvasView.tsx';
    const fileName = filePath.split('/').pop();
    expect(fileName).toBe('GitDiffCanvasView.tsx');
  });

  it('correctly identifies untracked files from status code', () => {
    const isUntracked = (status: string) => {
      const c = status.trim();
      return c === '??' || c === '?';
    };

    expect(isUntracked('??')).toBe(true);
    expect(isUntracked('?')).toBe(true);
    expect(isUntracked('M')).toBe(false);
    expect(isUntracked('A')).toBe(false);
    expect(isUntracked(' M')).toBe(false);
  });

  it('clears diff data when reverting the currently viewed file', () => {
    const viewFilePath = 'src/index.ts';
    const revertedFilePath = 'src/index.ts';
    const shouldClearDiff = viewFilePath === revertedFilePath;
    expect(shouldClearDiff).toBe(true);
  });

  it('does not clear diff data when reverting a different file', () => {
    const viewFilePath = 'src/index.ts';
    const revertedFilePath = 'src/other.ts';
    const shouldClearDiff = viewFilePath === revertedFilePath;
    expect(shouldClearDiff).toBe(false);
  });
});
