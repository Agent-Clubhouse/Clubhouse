import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../manifest-validator';
import { manifest } from './manifest';
import * as filesModule from './main';

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

    it('targets API v0.4', () => {
      expect(manifest.engine.api).toBe(0.4);
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

    it('contributes showHiddenFiles setting', () => {
      expect(manifest.contributes?.settings).toContainEqual(
        expect.objectContaining({ key: 'showHiddenFiles', type: 'boolean' }),
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
});
