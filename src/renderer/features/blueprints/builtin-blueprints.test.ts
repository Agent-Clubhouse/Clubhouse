import { describe, it, expect } from 'vitest';
import {
  createSmallSquadBlueprint,
  createLargeSquadBlueprint,
  BUILTIN_BLUEPRINTS,
  getBuiltinBlueprint,
  listBuiltinBlueprintSummaries,
  builtinBlueprintFilePath,
  isBuiltinBlueprintPath,
  BUILTIN_BLUEPRINT_PREFIX,
} from './builtin-blueprints';
import { validateManifest, importBlueprint } from './blueprint-import';

describe('built-in blueprints', () => {
  describe('Small Squad', () => {
    const bp = createSmallSquadBlueprint();

    it('has Group PM + 3 Developers + 1 QA (5 agents)', () => {
      expect(bp.agents).toHaveLength(5);
      const names = bp.agents!.map((a) => a.name);
      expect(names).toEqual(['Group PM', 'Developer 1', 'Developer 2', 'Developer 3', 'QA 1']);
    });

    it('has one agent view per agent', () => {
      expect(bp.canvas.views).toHaveLength(5);
      expect(bp.canvas.views.every((v) => v.type === 'agent')).toBe(true);
    });

    it('wires the Group PM to every other agent bidirectionally', () => {
      expect(bp.canvas.wires).toHaveLength(4);
      expect(bp.canvas.wires.every((w) => w.sourceRef === 'agent_gp')).toBe(true);
      expect(bp.canvas.wires.every((w) => w.bidirectional === true)).toBe(true);
    });

    it('is a valid manifest', () => {
      expect(validateManifest(bp)).toEqual({ valid: true, errors: [] });
    });
  });

  describe('Large Squad', () => {
    const bp = createLargeSquadBlueprint();

    it('has Group PM + 6 Developers + 2 QA (9 agents)', () => {
      expect(bp.agents).toHaveLength(9);
      const devs = bp.agents!.filter((a) => a.name.startsWith('Developer'));
      const qas = bp.agents!.filter((a) => a.name.startsWith('QA'));
      expect(devs).toHaveLength(6);
      expect(qas).toHaveLength(2);
    });

    it('has 9 agent views and 8 PM fan-out wires', () => {
      expect(bp.canvas.views).toHaveLength(9);
      expect(bp.canvas.wires).toHaveLength(8);
    });

    it('is a valid manifest', () => {
      expect(validateManifest(bp)).toEqual({ valid: true, errors: [] });
    });
  });

  describe('agent definitions', () => {
    it('developers run in worktrees with implementation skills', () => {
      const bp = createSmallSquadBlueprint();
      const dev = bp.agents!.find((a) => a.name === 'Developer 1')!;
      expect(dev.useWorktree).toBe(true);
      expect(dev.skills).toContain('mission');
      expect(dev.skills).toContain('create-pr');
    });

    it('QA has review/test skills', () => {
      const bp = createSmallSquadBlueprint();
      const qa = bp.agents!.find((a) => a.name === 'QA 1')!;
      expect(qa.skills).toContain('code-review');
      expect(qa.skills).toContain('test');
    });

    it('uses unique refIds across views and agents', () => {
      const bp = createLargeSquadBlueprint();
      const viewRefs = bp.canvas.views.map((v) => v.refId);
      const agentRefs = bp.agents!.map((a) => a.refId);
      expect(new Set(viewRefs).size).toBe(viewRefs.length);
      expect(new Set(agentRefs).size).toBe(agentRefs.length);
    });

    it('is deterministic (stable createdAt across calls)', () => {
      expect(createSmallSquadBlueprint().createdAt).toBe(createSmallSquadBlueprint().createdAt);
    });
  });

  describe('registry + resolution', () => {
    it('exposes both built-in templates', () => {
      expect(BUILTIN_BLUEPRINTS.map((b) => b.id)).toEqual(['small-squad', 'large-squad']);
    });

    it('resolves a manifest by id', () => {
      expect(getBuiltinBlueprint('small-squad')?.name).toBe('Small Squad');
      expect(getBuiltinBlueprint('large-squad')?.name).toBe('Large Squad');
    });

    it('resolves a manifest by builtin:// path', () => {
      const path = builtinBlueprintFilePath('small-squad');
      expect(path).toBe(`${BUILTIN_BLUEPRINT_PREFIX}small-squad`);
      expect(getBuiltinBlueprint(path)?.name).toBe('Small Squad');
    });

    it('returns undefined for unknown ids', () => {
      expect(getBuiltinBlueprint('nonexistent')).toBeUndefined();
    });

    it('identifies built-in paths', () => {
      expect(isBuiltinBlueprintPath('builtin://small-squad')).toBe(true);
      expect(isBuiltinBlueprintPath('/Users/x/.clubhouse/blueprints/foo.json')).toBe(false);
    });
  });

  describe('gallery summaries', () => {
    it('produces a summary per built-in with correct counts', () => {
      const summaries = listBuiltinBlueprintSummaries();
      expect(summaries).toHaveLength(2);

      const small = summaries.find((s) => s.name === 'Small Squad')!;
      expect(small.filePath).toBe('builtin://small-squad');
      expect(small.source).toBe('Built-in');
      expect(small.viewCount).toBe(5);
      expect(small.agentCount).toBe(5);
      expect(small.wireCount).toBe(4);
      expect(small.agentNames).toContain('Group PM');

      const large = summaries.find((s) => s.name === 'Large Squad')!;
      expect(large.agentCount).toBe(9);
      expect(large.wireCount).toBe(8);
    });
  });

  describe('import into canvas', () => {
    it('creates agent stub views for a fresh project (no existing agents)', () => {
      const bp = createSmallSquadBlueprint();
      const result = importBlueprint(bp, [], []);

      // 5 agent views, all unmatched stubs (nothing to bind to yet)
      expect(result.canvas.views).toHaveLength(5);
      expect(result.stubs).toHaveLength(5);
      expect(result.stubs.every((s) => s.badge === 'not_found')).toBe(true);
      expect(result.canvas.views.every((v) => v.type === 'agent')).toBe(true);

      // Wires are carried through as pending until agents are bound
      expect(result.pendingWires).toHaveLength(4);
    });
  });
});
