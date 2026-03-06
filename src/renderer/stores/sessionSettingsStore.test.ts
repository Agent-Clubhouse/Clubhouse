import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionSettingsStore } from './sessionSettingsStore';

const getState = () => useSessionSettingsStore.getState();

describe('sessionSettingsStore', () => {
  beforeEach(() => {
    useSessionSettingsStore.setState({
      promptForName: false,
      projectOverrides: {},
    });
    window.clubhouse.app.getSessionSettings = vi.fn().mockResolvedValue({
      promptForName: false,
      projectOverrides: {},
    });
    window.clubhouse.app.saveSessionSettings = vi.fn().mockResolvedValue(undefined);
  });

  describe('loadSettings', () => {
    it('loads settings from IPC', async () => {
      window.clubhouse.app.getSessionSettings = vi.fn().mockResolvedValue({
        promptForName: true,
        projectOverrides: { '/projects/a': false },
      });

      await getState().loadSettings();

      expect(getState().promptForName).toBe(true);
      expect(getState().projectOverrides).toEqual({ '/projects/a': false });
    });

    it('uses defaults when IPC fails', async () => {
      window.clubhouse.app.getSessionSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await getState().loadSettings();

      expect(getState().promptForName).toBe(false);
      expect(getState().projectOverrides).toEqual({});
    });
  });

  describe('setPromptForName', () => {
    it('updates app-level default', async () => {
      await getState().setPromptForName(true);

      expect(getState().promptForName).toBe(true);
      expect(window.clubhouse.app.saveSessionSettings).toHaveBeenCalledWith({
        promptForName: true,
        projectOverrides: {},
      });
    });

    it('reverts on save failure', async () => {
      window.clubhouse.app.saveSessionSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await getState().setPromptForName(true);

      expect(getState().promptForName).toBe(false);
    });
  });

  describe('shouldPrompt', () => {
    it('returns app default when no project override', () => {
      useSessionSettingsStore.setState({ promptForName: true, projectOverrides: {} });
      expect(getState().shouldPrompt('/projects/a')).toBe(true);
    });

    it('returns project override when set', () => {
      useSessionSettingsStore.setState({
        promptForName: true,
        projectOverrides: { '/projects/a': false },
      });
      expect(getState().shouldPrompt('/projects/a')).toBe(false);
    });

    it('returns app default when no project path', () => {
      useSessionSettingsStore.setState({ promptForName: true, projectOverrides: {} });
      expect(getState().shouldPrompt()).toBe(true);
    });
  });

  describe('setProjectOverride', () => {
    it('sets a project override', async () => {
      await getState().setProjectOverride('/projects/a', true);

      expect(getState().projectOverrides).toEqual({ '/projects/a': true });
      expect(window.clubhouse.app.saveSessionSettings).toHaveBeenCalled();
    });

    it('reverts on save failure', async () => {
      window.clubhouse.app.saveSessionSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await getState().setProjectOverride('/projects/a', true);

      expect(getState().projectOverrides).toEqual({});
    });
  });

  describe('clearProjectOverride', () => {
    it('removes a project override', async () => {
      useSessionSettingsStore.setState({
        promptForName: false,
        projectOverrides: { '/projects/a': true },
      });

      await getState().clearProjectOverride('/projects/a');

      expect(getState().projectOverrides).toEqual({});
      expect(window.clubhouse.app.saveSessionSettings).toHaveBeenCalled();
    });

    it('reverts on save failure', async () => {
      useSessionSettingsStore.setState({
        promptForName: false,
        projectOverrides: { '/projects/a': true },
      });
      window.clubhouse.app.saveSessionSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await getState().clearProjectOverride('/projects/a');

      expect(getState().projectOverrides).toEqual({ '/projects/a': true });
    });
  });
});
