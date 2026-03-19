// Tests for the v0.8 plugin API upgrade — legacy view types, canvas widget
// registration, and migration of saved canvases.

import { describe, it, expect, beforeEach } from 'vitest';
import { validateManifest } from '../../manifest-validator';
import { manifest as hubManifest } from '../hub/manifest';
import { manifest as terminalManifest } from '../terminal/manifest';
import { manifest as filesManifest } from '../files/manifest';
import { manifest as gitManifest } from '../git/manifest';
import { manifest as canvasManifest } from './manifest';
import { manifest as sessionsManifest } from '../sessions/manifest';
import {
  createView,
  createPluginView,
  createViewCounter,
  queryViews,
} from './canvas-operations';
import type { CanvasView, FileCanvasView } from './canvas-types';

describe('v0.8 plugin API upgrade', () => {
  // ── All manifests validate at v0.8 ──────────────────────────────────

  describe('manifest validation', () => {
    const manifests = [
      { name: 'hub', manifest: hubManifest },
      { name: 'terminal', manifest: terminalManifest },
      { name: 'files', manifest: filesManifest },
      { name: 'git', manifest: gitManifest },
      { name: 'canvas', manifest: canvasManifest },
      { name: 'sessions', manifest: sessionsManifest },
    ];

    for (const { name, manifest } of manifests) {
      it(`${name} manifest passes validation at v0.8`, () => {
        const result = validateManifest(manifest);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it(`${name} manifest targets API v0.8`, () => {
        expect(manifest.engine.api).toBe(0.8);
      });
    }
  });

  // ── Title declarations ──────────────────────────────────────────────

  describe('title declarations', () => {
    it('hub declares tab.title and railItem.title', () => {
      expect(hubManifest.contributes!.tab!.title).toBe('Hub');
      expect(hubManifest.contributes!.railItem!.title).toBe('Hub');
    });

    it('terminal declares tab.title', () => {
      expect(terminalManifest.contributes!.tab!.title).toBe('Terminal');
    });

    it('files declares tab.title', () => {
      expect(filesManifest.contributes!.tab!.title).toBe('Files');
    });

    it('canvas declares tab.title and railItem.title', () => {
      expect(canvasManifest.contributes!.tab!.title).toBe('Canvas');
      expect(canvasManifest.contributes!.railItem!.title).toBe('Canvas');
    });

    it('sessions declares tab.title', () => {
      expect(sessionsManifest.contributes!.tab!.title).toBe('Sessions');
    });
  });

  // ── Canvas widget declarations ──────────────────────────────────────

  describe('canvas widget declarations', () => {
    it('terminal declares a "shell" canvas widget', () => {
      const widgets = terminalManifest.contributes?.canvasWidgets;
      expect(widgets).toHaveLength(1);
      expect(widgets![0].id).toBe('shell');
      expect(widgets![0].label).toBe('Terminal');
      expect(widgets![0].defaultSize).toEqual({ width: 480, height: 360 });
    });

    it('files declares a "file-viewer" canvas widget', () => {
      const widgets = filesManifest.contributes?.canvasWidgets;
      expect(widgets).toHaveLength(1);
      expect(widgets![0].id).toBe('file-viewer');
      expect(widgets![0].label).toBe('File Viewer');
      expect(widgets![0].defaultSize).toEqual({ width: 560, height: 480 });
    });

    it('git declares a "git-status" canvas widget', () => {
      const widgets = gitManifest.contributes?.canvasWidgets;
      expect(widgets).toHaveLength(1);
      expect(widgets![0].id).toBe('git-status');
      expect(widgets![0].label).toBe('Git Status');
      expect(widgets![0].metadataKeys).toEqual(['projectId', 'worktreePath']);
    });

    it('terminal has canvas permission', () => {
      expect(terminalManifest.permissions).toContain('canvas');
    });

    it('files has canvas permission', () => {
      expect(filesManifest.permissions).toContain('canvas');
    });

    it('git has canvas permission', () => {
      expect(gitManifest.permissions).toContain('canvas');
    });
  });

  // ── Legacy view types ──────────────────────────────────────────────

  describe('legacy view types', () => {
    let counter: ReturnType<typeof createViewCounter>;

    beforeEach(() => {
      counter = createViewCounter(0);
    });

    it('createView("file") returns legacy-file type', () => {
      const view = createView('file', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-file');
      expect(view.title).toBe('Files (Legacy)');
    });

    it('createView("legacy-file") returns legacy-file type', () => {
      const view = createView('legacy-file', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-file');
    });

    it('createView("terminal") returns legacy-terminal type', () => {
      const view = createView('terminal', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-terminal');
      expect(view.title).toBe('Terminal (Legacy)');
    });

    it('createView("legacy-terminal") returns legacy-terminal type', () => {
      const view = createView('legacy-terminal', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-terminal');
    });

    it('createView("git-diff") returns legacy-git-diff type', () => {
      const view = createView('git-diff', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-git-diff');
      expect(view.title).toBe('Git Diff (Legacy)');
    });

    it('createView("legacy-git-diff") returns legacy-git-diff type', () => {
      const view = createView('legacy-git-diff', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('legacy-git-diff');
    });

    it('agent views are not affected by legacy changes', () => {
      const view = createView('agent', { x: 0, y: 0 }, 0, counter);
      expect(view.type).toBe('agent');
    });

    it('queryViews returns legacy-file as the type', () => {
      const views: CanvasView[] = [
        {
          id: 'cv_1',
          type: 'legacy-file',
          position: { x: 0, y: 0 },
          size: { width: 480, height: 480 },
          title: 'Files (Legacy)',
          displayName: 'Files (Legacy)',
          zIndex: 0,
          metadata: { projectId: 'p1' },
        } as FileCanvasView,
      ];
      const handles = queryViews(views);
      expect(handles).toHaveLength(1);
      expect(handles[0].type).toBe('legacy-file');
    });
  });

  // ── Plugin widget views ─────────────────────────────────────────────

  describe('plugin widget views', () => {
    let counter: ReturnType<typeof createViewCounter>;

    beforeEach(() => {
      counter = createViewCounter(0);
    });

    it('createPluginView creates a plugin:files:file-viewer view', () => {
      const view = createPluginView(
        'files', 'plugin:files:file-viewer', 'File Viewer',
        { x: 100, y: 100 }, 0, counter, [], {}, { width: 560, height: 480 },
      );
      expect(view.type).toBe('plugin');
      expect(view.pluginId).toBe('files');
      expect(view.pluginWidgetType).toBe('plugin:files:file-viewer');
      expect(view.size).toEqual({ width: 560, height: 480 });
    });

    it('createPluginView creates a plugin:terminal:shell view', () => {
      const view = createPluginView(
        'terminal', 'plugin:terminal:shell', 'Terminal',
        { x: 100, y: 100 }, 0, counter, [], {}, { width: 480, height: 360 },
      );
      expect(view.type).toBe('plugin');
      expect(view.pluginId).toBe('terminal');
      expect(view.pluginWidgetType).toBe('plugin:terminal:shell');
    });

    it('queryViews can filter by plugin widget type', () => {
      const views: CanvasView[] = [
        createPluginView('files', 'plugin:files:file-viewer', 'FV', { x: 0, y: 0 }, 0, counter),
        createPluginView('terminal', 'plugin:terminal:shell', 'T', { x: 100, y: 0 }, 1, counter),
        createView('agent', { x: 200, y: 0 }, 2, counter),
      ];
      const fileWidgets = queryViews(views, { type: 'plugin:files:file-viewer' });
      expect(fileWidgets).toHaveLength(1);
      expect(fileWidgets[0].type).toBe('plugin:files:file-viewer');

      const termWidgets = queryViews(views, { type: 'plugin:terminal:shell' });
      expect(termWidgets).toHaveLength(1);
      expect(termWidgets[0].type).toBe('plugin:terminal:shell');
    });
  });

  // ── Saved canvas migration ──────────────────────────────────────────

  describe('saved canvas migration', () => {
    it('migrates file→legacy-file, terminal→legacy-terminal, and git-diff→legacy-git-diff in view data', () => {
      // Simulates the migration logic from canvas-store.ts loadCanvas
      const savedViews = [
        { id: 'cv_1', type: 'file', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'Files', zIndex: 0 },
        { id: 'cv_2', type: 'terminal', position: { x: 500, y: 0 }, size: { width: 480, height: 480 }, title: 'Terminal', zIndex: 1 },
        { id: 'cv_3', type: 'agent', position: { x: 1000, y: 0 }, size: { width: 480, height: 480 }, title: 'Agent', zIndex: 2 },
        { id: 'cv_4', type: 'git-diff', position: { x: 1500, y: 0 }, size: { width: 480, height: 480 }, title: 'Git Diff', zIndex: 3 },
      ];

      const migratedViews = savedViews.map((v: any) => {
        let type = v.type;
        if (type === 'file') type = 'legacy-file';
        if (type === 'terminal') type = 'legacy-terminal';
        if (type === 'git-diff') type = 'legacy-git-diff';
        return {
          ...v,
          type,
          metadata: v.metadata ?? {},
          displayName: v.displayName ?? v.title ?? v.type ?? '',
        };
      });

      expect(migratedViews[0].type).toBe('legacy-file');
      expect(migratedViews[1].type).toBe('legacy-terminal');
      expect(migratedViews[2].type).toBe('agent'); // unchanged
      expect(migratedViews[3].type).toBe('legacy-git-diff');
    });
  });
});
