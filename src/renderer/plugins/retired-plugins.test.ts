import { describe, it, expect } from 'vitest';
import { RETIRED_EXPERIMENTAL_FLAGS, migrateRetiredExplorerTab, stripRetiredPluginIds } from './retired-plugins';

describe('retired-plugins', () => {
  describe('stripRetiredPluginIds', () => {
    it('removes the Hub from a persisted enabled list', () => {
      expect(stripRetiredPluginIds(['hub', 'terminal', 'canvas'])).toEqual({
        ids: ['terminal', 'canvas'],
        changed: true,
      });
    });

    it('removes Sessions and Agent Queue from a persisted enabled list', () => {
      expect(stripRetiredPluginIds(['sessions', 'canvas', 'agent-queue', 'group-project'])).toEqual({
        ids: ['canvas', 'group-project'],
        changed: true,
      });
    });

    it('reports no change when nothing retired is present', () => {
      expect(stripRetiredPluginIds(['terminal', 'files'])).toEqual({
        ids: ['terminal', 'files'],
        changed: false,
      });
    });

    it('keeps a retired ID that a currently registered plugin uses', () => {
      expect(stripRetiredPluginIds(['hub', 'files'], (id) => id === 'hub')).toEqual({
        ids: ['hub', 'files'],
        changed: false,
      });
    });

    it('does not touch IDs that merely contain a retired ID', () => {
      expect(stripRetiredPluginIds(['my-hub', 'hub-tools']).ids).toEqual(['my-hub', 'hub-tools']);
    });
  });

  describe('migrateRetiredExplorerTab', () => {
    it('maps project and app Hub tabs to agents', () => {
      expect(migrateRetiredExplorerTab('plugin:hub')).toBe('agents');
      expect(migrateRetiredExplorerTab('plugin:app:hub')).toBe('agents');
    });

    it('maps the removed Assistant tab and retired plugin tabs to agents', () => {
      expect(migrateRetiredExplorerTab('assistant')).toBe('agents');
      expect(migrateRetiredExplorerTab('plugin:sessions')).toBe('agents');
      expect(migrateRetiredExplorerTab('plugin:app:agent-queue')).toBe('agents');
    });

    it('leaves other tabs alone', () => {
      for (const tab of ['agents', 'settings', 'help', 'plugin:canvas', 'plugin:app:canvas', 'plugin:my-hub']) {
        expect(migrateRetiredExplorerTab(tab)).toBe(tab);
      }
    });

    it('keeps the tab when a registered plugin owns the retired ID', () => {
      expect(migrateRetiredExplorerTab('plugin:hub', (id) => id === 'hub')).toBe('plugin:hub');
    });
  });

  it('lists the flags of removed experimental features', () => {
    expect([...RETIRED_EXPERIMENTAL_FLAGS].sort()).toEqual(['agentQueue', 'assistant', 'sessions']);
  });
});
