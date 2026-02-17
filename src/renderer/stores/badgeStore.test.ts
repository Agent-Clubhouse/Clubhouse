import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBadgeStore, BadgeTarget } from './badgeStore';

function getState() {
  return useBadgeStore.getState();
}

function reset() {
  useBadgeStore.setState({ badges: {} });
}

describe('badgeStore', () => {
  beforeEach(() => {
    reset();
  });

  describe('setBadge', () => {
    it('adds a count badge for an explorer tab', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 3, target);
      expect(Object.keys(getState().badges)).toHaveLength(1);
      const badge = Object.values(getState().badges)[0];
      expect(badge.source).toBe('core:agents');
      expect(badge.type).toBe('count');
      expect(badge.value).toBe(3);
      expect(badge.target).toEqual(target);
    });

    it('adds a dot badge for an explorer tab', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'dot', 1, target);
      const badge = Object.values(getState().badges)[0];
      expect(badge.type).toBe('dot');
      expect(badge.value).toBe(1);
    });

    it('adds a badge for an app-plugin', () => {
      const target: BadgeTarget = { kind: 'app-plugin', pluginId: 'hub' };
      getState().setBadge('plugin:hub', 'count', 5, target);
      const badge = Object.values(getState().badges)[0];
      expect(badge.source).toBe('plugin:hub');
      expect(badge.target).toEqual(target);
    });

    it('overwrites an existing badge from the same source to the same target', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 3, target);
      getState().setBadge('core:agents', 'count', 7, target);
      expect(Object.keys(getState().badges)).toHaveLength(1);
      expect(Object.values(getState().badges)[0].value).toBe(7);
    });

    it('allows multiple sources to badge the same target', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 3, target);
      getState().setBadge('plugin:my-plugin', 'count', 2, target);
      expect(Object.keys(getState().badges)).toHaveLength(2);
    });

    it('generates deterministic IDs', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 1, target);
      const id = Object.keys(getState().badges)[0];
      expect(id).toBe('core:agents::explorer-tab:p1:agents');
    });

    it('generates deterministic IDs for app-plugin targets', () => {
      const target: BadgeTarget = { kind: 'app-plugin', pluginId: 'hub' };
      getState().setBadge('plugin:hub', 'count', 1, target);
      const id = Object.keys(getState().badges)[0];
      expect(id).toBe('plugin:hub::app-plugin:hub');
    });
  });

  describe('clearBadge', () => {
    it('removes a specific badge by ID', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 3, target);
      const id = Object.keys(getState().badges)[0];
      getState().clearBadge(id);
      expect(Object.keys(getState().badges)).toHaveLength(0);
    });

    it('does nothing for non-existent IDs', () => {
      getState().clearBadge('nonexistent');
      expect(Object.keys(getState().badges)).toHaveLength(0);
    });
  });

  describe('clearBySource', () => {
    it('removes all badges from a given source', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p2', tabId: 'agents' });
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      getState().clearBySource('core:agents');
      expect(Object.keys(getState().badges)).toHaveLength(1);
      expect(Object.values(getState().badges)[0].source).toBe('plugin:hub');
    });
  });

  describe('clearByTarget', () => {
    it('removes all badges for a specific explorer-tab target', () => {
      const target: BadgeTarget = { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' };
      getState().setBadge('core:agents', 'count', 3, target);
      getState().setBadge('plugin:other', 'dot', 1, target);
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      getState().clearByTarget(target);
      expect(Object.keys(getState().badges)).toHaveLength(1);
      expect(Object.values(getState().badges)[0].source).toBe('plugin:hub');
    });

    it('removes all badges for a specific app-plugin target', () => {
      const target: BadgeTarget = { kind: 'app-plugin', pluginId: 'hub' };
      getState().setBadge('plugin:hub', 'count', 5, target);
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().clearByTarget(target);
      expect(Object.keys(getState().badges)).toHaveLength(1);
    });
  });

  describe('clearProjectBadges', () => {
    it('removes all explorer-tab badges for a specific project', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:issues', 'count', 2, { kind: 'explorer-tab', projectId: 'p1', tabId: 'plugin:issues' });
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p2', tabId: 'agents' });
      getState().clearProjectBadges('p1');
      expect(Object.keys(getState().badges)).toHaveLength(1);
      expect(Object.values(getState().badges)[0].target).toEqual({ kind: 'explorer-tab', projectId: 'p2', tabId: 'agents' });
    });
  });

  describe('clearAll', () => {
    it('removes all badges', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      getState().clearAll();
      expect(Object.keys(getState().badges)).toHaveLength(0);
    });
  });

  describe('getTabBadge', () => {
    it('returns null when no badges exist for that tab', () => {
      expect(getState().getTabBadge('p1', 'agents')).toBeNull();
    });

    it('returns count badge for a single count badge', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      expect(getState().getTabBadge('p1', 'agents')).toEqual({ type: 'count', value: 3 });
    });

    it('sums multiple count badges from different sources', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:other', 'count', 2, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      expect(getState().getTabBadge('p1', 'agents')).toEqual({ type: 'count', value: 5 });
    });

    it('returns dot when only dot badges exist', () => {
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      expect(getState().getTabBadge('p1', 'agents')).toEqual({ type: 'dot', value: 1 });
    });

    it('returns count (ignoring dots) when both count and dot badges exist', () => {
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:other', 'count', 2, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      expect(getState().getTabBadge('p1', 'agents')).toEqual({ type: 'count', value: 2 });
    });
  });

  describe('getProjectBadge', () => {
    it('returns null when no explorer-tab badges exist for the project', () => {
      expect(getState().getProjectBadge('p1')).toBeNull();
    });

    it('sums count badges across all tabs for a project', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:issues', 'count', 2, { kind: 'explorer-tab', projectId: 'p1', tabId: 'plugin:issues' });
      expect(getState().getProjectBadge('p1')).toEqual({ type: 'count', value: 5 });
    });

    it('returns dot when only dot badges exist', () => {
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      expect(getState().getProjectBadge('p1')).toEqual({ type: 'dot', value: 1 });
    });

    it('does not include badges from other projects', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('core:agents', 'count', 5, { kind: 'explorer-tab', projectId: 'p2', tabId: 'agents' });
      expect(getState().getProjectBadge('p1')).toEqual({ type: 'count', value: 3 });
    });
  });

  describe('getAppPluginBadge', () => {
    it('returns null when no badge exists for the plugin', () => {
      expect(getState().getAppPluginBadge('hub')).toBeNull();
    });

    it('returns the badge for a specific app-plugin', () => {
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      expect(getState().getAppPluginBadge('hub')).toEqual({ type: 'count', value: 5 });
    });

    it('sums multiple sources for the same app-plugin', () => {
      getState().setBadge('plugin:hub', 'count', 3, { kind: 'app-plugin', pluginId: 'hub' });
      getState().setBadge('plugin:other', 'count', 2, { kind: 'app-plugin', pluginId: 'hub' });
      expect(getState().getAppPluginBadge('hub')).toEqual({ type: 'count', value: 5 });
    });
  });

  describe('getDockCount', () => {
    it('returns 0 when no badges exist', () => {
      expect(getState().getDockCount()).toBe(0);
    });

    it('sums count badges across projects and app-plugins', () => {
      getState().setBadge('core:agents', 'count', 3, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:issues', 'count', 2, { kind: 'explorer-tab', projectId: 'p2', tabId: 'plugin:issues' });
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      expect(getState().getDockCount()).toBe(10);
    });

    it('dots contribute 0 to the dock count', () => {
      getState().setBadge('core:agents', 'dot', 1, { kind: 'explorer-tab', projectId: 'p1', tabId: 'agents' });
      getState().setBadge('plugin:hub', 'count', 5, { kind: 'app-plugin', pluginId: 'hub' });
      expect(getState().getDockCount()).toBe(5);
    });
  });
});
