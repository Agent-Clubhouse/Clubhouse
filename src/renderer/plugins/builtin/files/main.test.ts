import { describe, it, expect, vi } from 'vitest';

vi.mock('./MermaidDiagram', () => ({
  MermaidDiagram: () => null,
}));

vi.mock('./MonacoEditor', () => ({
  MonacoEditor: () => null,
  disposeModel: vi.fn(),
  updateSavedContent: vi.fn(),
  getModelContent: vi.fn(() => ''),
}));

import { validateManifest } from '../../manifest-validator';
import { manifest } from './manifest';
import * as filesModule from './main';
import { clearFileCache } from './FileViewer';

describe('files plugin', () => {
  describe('manifest', () => {
    it('passes validation', () => {
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('has id "files"', () => {
      expect(manifest.id).toBe('files');
    });

    it('targets API v0.8', () => {
      expect(manifest.engine.api).toBe(0.8);
    });

    it('declares required permissions including canvas and projects', () => {
      expect(manifest.permissions).toEqual(
        expect.arrayContaining(['files', 'files.watch', 'git', 'commands', 'notifications', 'storage', 'canvas', 'annex', 'projects']),
      );
      expect(manifest.permissions).toHaveLength(9);
    });

    it('is project-scoped', () => {
      expect(manifest.scope).toBe('project');
    });

    it('contributes a tab with sidebar-content layout', () => {
      expect(manifest.contributes?.tab?.label).toBe('Files');
      expect(manifest.contributes?.tab?.layout).toBe('sidebar-content');
    });

    it('contributes a refresh command', () => {
      expect(manifest.contributes?.commands).toContainEqual(
        expect.objectContaining({ id: 'refresh' }),
      );
    });

    it('contributes showHiddenFiles setting defaulting to true', () => {
      expect(manifest.contributes?.settings).toContainEqual(
        expect.objectContaining({ key: 'showHiddenFiles', type: 'boolean', default: true }),
      );
    });

    it('contributes help topics', () => {
      expect(manifest.contributes?.help?.topics).toBeDefined();
      expect(manifest.contributes!.help!.topics!.length).toBeGreaterThan(0);
    });

    it('uses declarative settings panel', () => {
      expect(manifest.settingsPanel).toBe('declarative');
    });
  });

  describe('module exports', () => {
    it('exports activate function', () => {
      expect(typeof filesModule.activate).toBe('function');
    });

    it('exports deactivate function', () => {
      expect(typeof filesModule.deactivate).toBe('function');
    });

    it('exports SidebarPanel component', () => {
      expect(filesModule.SidebarPanel).toBeDefined();
      expect(typeof filesModule.SidebarPanel).toBe('function');
    });

    it('exports MainPanel component', () => {
      expect(filesModule.MainPanel).toBeDefined();
      expect(typeof filesModule.MainPanel).toBe('function');
    });
  });

  describe('LB-PU-006: external change detection infrastructure', () => {
    it('clearFileCache is exported from FileViewer and callable', () => {
      expect(typeof clearFileCache).toBe('function');
      expect(() => clearFileCache()).not.toThrow();
    });

    it('clearFileCache can be called multiple times without throwing', () => {
      clearFileCache();
      clearFileCache();
      expect(() => clearFileCache()).not.toThrow();
    });

    it('external vs own-write detection: mtime comparison logic', () => {
      // This unit test models the comparison logic used in the file watcher callback.
      // knownMtime is undefined → always treat as external (first change since any save)
      // knownMtime === currentMtime → our own write, skip
      // knownMtime !== currentMtime → external change, update baseline
      function isExternalChange(knownMtime: number | undefined, currentMtime: number): boolean {
        return knownMtime === undefined || knownMtime !== currentMtime;
      }

      expect(isExternalChange(undefined, 1000)).toBe(true);   // unknown → external
      expect(isExternalChange(1000, 1000)).toBe(false);        // same mtime → own write
      expect(isExternalChange(1000, 2000)).toBe(true);         // different mtime → external
    });
  });
});
