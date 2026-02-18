import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as fs from 'fs';
import {
  readMarker,
  writeMarker,
  clearMarker,
  shouldShowSafeModeDialog,
  incrementAttempt,
} from './safe-mode';

const MARKER_PATH = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', '.startup-marker');

describe('safe-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readMarker', () => {
    it('returns parsed marker when file exists', () => {
      const marker = { timestamp: 1000, attempt: 2, lastEnabledPlugins: ['a'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(marker));
      expect(readMarker()).toEqual(marker);
    });

    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readMarker()).toBeNull();
    });

    it('returns null on corrupt JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{{invalid');
      expect(readMarker()).toBeNull();
    });
  });

  describe('writeMarker', () => {
    it('creates marker with attempt=1 when no existing marker', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      writeMarker(['plugin-a']);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        MARKER_PATH,
        expect.any(String),
        expect.anything(),
      );
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(1);
      expect(written.lastEnabledPlugins).toEqual(['plugin-a']);
      expect(typeof written.timestamp).toBe('number');
    });

    it('increments attempt when existing marker exists', () => {
      const existing = { timestamp: 1000, attempt: 1, lastEnabledPlugins: ['old'] };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existing));
      writeMarker(['new-plugin']);
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(2);
      expect(written.lastEnabledPlugins).toEqual(['new-plugin']);
    });
  });

  describe('clearMarker', () => {
    it('deletes the marker file', () => {
      clearMarker();
      expect(fs.unlinkSync).toHaveBeenCalledWith(MARKER_PATH);
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => clearMarker()).not.toThrow();
    });
  });

  describe('shouldShowSafeModeDialog', () => {
    it('returns false when no marker exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(shouldShowSafeModeDialog()).toBe(false);
    });

    it('returns false when attempt is 1', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 1, lastEnabledPlugins: [] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(false);
    });

    it('returns true when attempt is 2', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 2, lastEnabledPlugins: ['a'] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(true);
    });

    it('returns true when attempt is greater than 2', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ timestamp: 1000, attempt: 5, lastEnabledPlugins: [] }),
      );
      expect(shouldShowSafeModeDialog()).toBe(true);
    });
  });

  describe('incrementAttempt', () => {
    it('calls writeMarker (alias)', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      incrementAttempt(['plugin-a']);
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.attempt).toBe(1);
    });
  });
});
