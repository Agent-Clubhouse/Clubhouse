import { describe, it, expect } from 'vitest';
import {
  ALL_PLUGIN_PERMISSIONS,
  PERMISSION_HIERARCHY,
  PERMISSION_RISK_LEVELS,
  RISK_LEVEL_LABELS,
  getParentPermission,
  getRequiredParentPermissions,
} from './plugin-types';
import type { PluginPermission, PermissionRiskLevel } from './plugin-types';

describe('permission hierarchy', () => {
  describe('PERMISSION_HIERARCHY', () => {
    it('every child key is a valid permission', () => {
      for (const child of Object.keys(PERMISSION_HIERARCHY)) {
        expect(ALL_PLUGIN_PERMISSIONS).toContain(child);
      }
    });

    it('every parent value is a valid permission', () => {
      for (const parent of Object.values(PERMISSION_HIERARCHY)) {
        expect(ALL_PLUGIN_PERMISSIONS).toContain(parent);
      }
    });

    it('no permission is its own parent', () => {
      for (const [child, parent] of Object.entries(PERMISSION_HIERARCHY)) {
        expect(child).not.toBe(parent);
      }
    });

    it('contains the expected parent-child relationships', () => {
      expect(PERMISSION_HIERARCHY['files.external']).toBe('files');
      expect(PERMISSION_HIERARCHY['agent-config.cross-project']).toBe('agent-config');
      expect(PERMISSION_HIERARCHY['agent-config.permissions']).toBe('agent-config');
      expect(PERMISSION_HIERARCHY['agent-config.mcp']).toBe('agent-config');
      expect(PERMISSION_HIERARCHY['agents.free-agent-mode']).toBe('agents');
    });

    it('has no cycles (hierarchy is a DAG)', () => {
      for (const startPerm of Object.keys(PERMISSION_HIERARCHY) as PluginPermission[]) {
        const visited = new Set<string>();
        let current: PluginPermission | null = startPerm;
        while (current !== null) {
          expect(visited.has(current)).toBe(false);
          visited.add(current);
          current = PERMISSION_HIERARCHY[current] ?? null;
        }
      }
    });
  });

  describe('PERMISSION_RISK_LEVELS', () => {
    it('covers all permissions', () => {
      for (const perm of ALL_PLUGIN_PERMISSIONS) {
        expect(PERMISSION_RISK_LEVELS[perm]).toBeDefined();
        expect(['safe', 'elevated', 'dangerous']).toContain(PERMISSION_RISK_LEVELS[perm]);
      }
    });

    it('classifies dangerous permissions correctly', () => {
      expect(PERMISSION_RISK_LEVELS['agent-config.permissions']).toBe('dangerous');
      expect(PERMISSION_RISK_LEVELS['agents.free-agent-mode']).toBe('dangerous');
    });

    it('classifies safe permissions correctly', () => {
      expect(PERMISSION_RISK_LEVELS['logging']).toBe('safe');
      expect(PERMISSION_RISK_LEVELS['theme']).toBe('safe');
      expect(PERMISSION_RISK_LEVELS['events']).toBe('safe');
      expect(PERMISSION_RISK_LEVELS['badges']).toBe('safe');
    });

    it('classifies elevated permissions correctly', () => {
      expect(PERMISSION_RISK_LEVELS['files']).toBe('elevated');
      expect(PERMISSION_RISK_LEVELS['terminal']).toBe('elevated');
      expect(PERMISSION_RISK_LEVELS['process']).toBe('elevated');
    });
  });

  describe('RISK_LEVEL_LABELS', () => {
    it('has labels for all risk levels', () => {
      const levels: PermissionRiskLevel[] = ['safe', 'elevated', 'dangerous'];
      for (const level of levels) {
        expect(typeof RISK_LEVEL_LABELS[level]).toBe('string');
        expect(RISK_LEVEL_LABELS[level].length).toBeGreaterThan(0);
      }
    });
  });

  describe('getParentPermission', () => {
    it('returns parent for child permissions', () => {
      expect(getParentPermission('files.external')).toBe('files');
      expect(getParentPermission('agent-config.cross-project')).toBe('agent-config');
      expect(getParentPermission('agent-config.permissions')).toBe('agent-config');
      expect(getParentPermission('agent-config.mcp')).toBe('agent-config');
      expect(getParentPermission('agents.free-agent-mode')).toBe('agents');
    });

    it('returns null for root permissions', () => {
      expect(getParentPermission('files')).toBeNull();
      expect(getParentPermission('git')).toBeNull();
      expect(getParentPermission('terminal')).toBeNull();
      expect(getParentPermission('agents')).toBeNull();
      expect(getParentPermission('agent-config')).toBeNull();
    });
  });

  describe('getRequiredParentPermissions', () => {
    it('returns empty array for root permissions', () => {
      expect(getRequiredParentPermissions('files')).toEqual([]);
      expect(getRequiredParentPermissions('agents')).toEqual([]);
      expect(getRequiredParentPermissions('agent-config')).toEqual([]);
    });

    it('returns single parent for direct child permissions', () => {
      expect(getRequiredParentPermissions('files.external')).toEqual(['files']);
      expect(getRequiredParentPermissions('agents.free-agent-mode')).toEqual(['agents']);
      expect(getRequiredParentPermissions('agent-config.cross-project')).toEqual(['agent-config']);
    });

    it('returns all ancestors for deeply nested permissions (if any)', () => {
      // Currently the hierarchy is only one level deep, but this tests the recursion
      const parents = getRequiredParentPermissions('agent-config.mcp');
      expect(parents).toEqual(['agent-config']);
    });
  });
});
