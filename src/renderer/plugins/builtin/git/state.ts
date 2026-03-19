/**
 * Shared module-level state for the git plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate shared state.
 */

import type { GitInfo, GitLogEntry, GitCommitFileEntry } from '../../../../shared/types';

export interface GitPluginState {
  // Data
  gitInfo: GitInfo | null;
  commitLog: GitLogEntry[];
  selectedCommitFiles: GitCommitFileEntry[];

  // UI
  selectedFile: string | null;
  selectedCommit: string | null;
  commitMessage: string;
  expandedSections: Record<string, boolean>;
}

const defaultState: GitPluginState = {
  gitInfo: null,
  commitLog: [],
  selectedCommitFiles: [],
  selectedFile: null,
  selectedCommit: null,
  commitMessage: '',
  expandedSections: { staged: true, unstaged: true, untracked: true, branches: false, log: true, stash: false },
};

export const gitState = {
  ...defaultState,
  listeners: new Set<() => void>(),

  setGitInfo(info: GitInfo | null): void {
    this.gitInfo = info;
    this.notify();
  },

  setCommitLog(log: GitLogEntry[]): void {
    this.commitLog = log;
    this.notify();
  },

  setSelectedCommitFiles(files: GitCommitFileEntry[]): void {
    this.selectedCommitFiles = files;
    this.notify();
  },

  setSelectedFile(file: string | null): void {
    this.selectedFile = file;
    this.notify();
  },

  setSelectedCommit(hash: string | null): void {
    this.selectedCommit = hash;
    this.notify();
  },

  setCommitMessage(message: string): void {
    this.commitMessage = message;
    this.notify();
  },

  toggleSection(section: string): void {
    this.expandedSections = {
      ...this.expandedSections,
      [section]: !this.expandedSections[section],
    };
    this.notify();
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  reset(): void {
    Object.assign(this, defaultState);
    this.listeners.clear();
  },
};
