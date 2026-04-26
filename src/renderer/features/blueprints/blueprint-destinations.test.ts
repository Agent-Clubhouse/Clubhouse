import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BlueprintManifest } from '../../../shared/blueprint-types';
import { saveToBlueprintsDir, saveToClipboard, saveToFile } from './blueprint-destinations';

// ── Fixtures & mocks ─────────────────────────────────────────────────

function makeManifest(overrides: Partial<BlueprintManifest> = {}): BlueprintManifest {
  return {
    id: 'bp-1',
    name: 'My Blueprint',
    version: '1.0.0',
    schemaVersion: 1,
    createdAt: '2026-04-25T12:00:00.000Z',
    canvas: { views: [], wires: [] },
    ...overrides,
  };
}

const mockFileWrite = vi.fn();
const mockFileMkdir = vi.fn();
const mockSaveToFile = vi.fn();
const mockClipboardWriteText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window ??= {};
  (globalThis as any).window.clubhouse = {
    file: { write: mockFileWrite, mkdir: mockFileMkdir },
    blueprint: { saveToFile: mockSaveToFile },
  };
  (globalThis as any).navigator ??= {};
  (globalThis as any).navigator.clipboard = { writeText: mockClipboardWriteText };
});

// ── saveToBlueprintsDir ──────────────────────────────────────────────

describe('saveToBlueprintsDir', () => {
  it('creates the blueprints directory and writes a slugified filename', async () => {
    mockFileMkdir.mockResolvedValueOnce(undefined);
    mockFileWrite.mockResolvedValueOnce(undefined);

    const result = await saveToBlueprintsDir(
      makeManifest({ name: 'My Cool Blueprint!' }),
      '/Users/me/projects/foo',
    );

    expect(result.success).toBe(true);
    expect(result.destination).toBe('blueprints-dir');
    expect(result.filePath).toBe('/Users/me/projects/foo/.clubhouse/blueprints/my-cool-blueprint.json');
    expect(mockFileMkdir).toHaveBeenCalledWith('/Users/me/projects/foo/.clubhouse/blueprints');
  });

  it('returns failure when mkdir/write throws', async () => {
    mockFileMkdir.mockRejectedValueOnce(new Error('EACCES'));

    const result = await saveToBlueprintsDir(makeManifest(), '/p');
    expect(result.success).toBe(false);
    expect(result.error).toContain('EACCES');
  });
});

// ── saveToClipboard ──────────────────────────────────────────────────

describe('saveToClipboard', () => {
  it('writes serialised manifest JSON to the system clipboard', async () => {
    mockClipboardWriteText.mockResolvedValueOnce(undefined);

    const result = await saveToClipboard(makeManifest());

    expect(result.success).toBe(true);
    expect(mockClipboardWriteText).toHaveBeenCalledTimes(1);
    const payload = mockClipboardWriteText.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.name).toBe('My Blueprint');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('returns failure when clipboard rejects', async () => {
    mockClipboardWriteText.mockRejectedValueOnce(new Error('Permission denied'));

    const result = await saveToClipboard(makeManifest());
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
  });
});

// ── saveToFile ────────────────────────────────────────────────────────

describe('saveToFile', () => {
  it('routes through the combined saveToFile IPC (no separate file.write)', async () => {
    // Critical: this is the regression guard for "can't save outside the
    // project directory". The renderer must NOT route via window.clubhouse.file.write
    // because that path is sandboxed.
    mockSaveToFile.mockResolvedValueOnce({
      canceled: false,
      filePath: '/Users/me/Desktop/board.json',
    });

    const manifest = makeManifest({ name: 'Board' });
    const result = await saveToFile(manifest);

    expect(result.success).toBe(true);
    expect(result.filePath).toBe('/Users/me/Desktop/board.json');

    // Verify the IPC was called with a slug filename + serialised JSON content.
    expect(mockSaveToFile).toHaveBeenCalledTimes(1);
    const [defaultName, content] = mockSaveToFile.mock.calls[0];
    expect(defaultName).toBe('board.json');
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe('Board');

    // Must NOT use the sandboxed file.write IPC.
    expect(mockFileWrite).not.toHaveBeenCalled();
  });

  it('returns Cancelled when the user dismisses the save dialog', async () => {
    mockSaveToFile.mockResolvedValueOnce({ canceled: true });

    const result = await saveToFile(makeManifest());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Cancelled');
  });

  it('surfaces write errors returned from the IPC', async () => {
    mockSaveToFile.mockResolvedValueOnce({
      canceled: false,
      filePath: '/readonly/board.json',
      error: 'EROFS: read-only filesystem',
    });

    const result = await saveToFile(makeManifest());
    expect(result.success).toBe(false);
    expect(result.error).toContain('EROFS');
    expect(result.filePath).toBe('/readonly/board.json');
  });

  it('catches IPC rejection', async () => {
    mockSaveToFile.mockRejectedValueOnce(new Error('IPC channel closed'));

    const result = await saveToFile(makeManifest());
    expect(result.success).toBe(false);
    expect(result.error).toContain('IPC channel closed');
  });
});
