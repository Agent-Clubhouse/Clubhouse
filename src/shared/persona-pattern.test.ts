import { describe, it, expect } from 'vitest';
import {
  parsePersonaFile,
  serializePersonaFile,
  stripPersonaFrontMatter,
  PatternSettings,
} from './persona-pattern';

describe('persona-pattern', () => {
  describe('parse / serialize round-trip', () => {
    it('round-trips settings including nested mcpConfigs', () => {
      const settings: PatternSettings = {
        model: 'claude-opus-4-8',
        orchestrator: 'claude-code',
        mcpIds: ['github', 'linear'],
        mcpConfigs: { github: { token: 'x' } },
        freeAgentMode: true,
        structuredMode: false,
        mission: 'implement-and-ship',
        buildCommand: 'npm run build',
        sourceControlProvider: 'azure-devops',
      };
      const body = '# Role: Reviewer\n\nDo the thing.';
      const file = serializePersonaFile(settings, body);
      const parsed = parsePersonaFile(file);
      expect(parsed.settings).toEqual(settings);
      expect(parsed.body).toBe(body);
    });

    it('round-trips skills bundling settings', () => {
      const settings: PatternSettings = {
        model: 'claude-opus-4-8',
        skills: [
          { name: 'mission', cadence: undefined },
          { name: 'group-pm-polling', cadence: '15m' },
        ],
      };
      const body = '# Role: Group Project PM\n\nCoordinate work.';
      const file = serializePersonaFile(settings, body);
      const parsed = parsePersonaFile(file);
      expect(parsed.settings).toEqual(settings);
      expect(parsed.body).toBe(body);
    });

    it('emits no front-matter when there are no settings', () => {
      const body = '# Just content';
      expect(serializePersonaFile({}, body)).toBe(body);
      expect(parsePersonaFile(body)).toEqual({ settings: {}, body });
    });

    it('omits empty arrays and empty objects', () => {
      const file = serializePersonaFile({ mcpIds: [], mcpConfigs: {}, model: 'x' }, 'body');
      expect(file).toContain('model: "x"');
      expect(file).not.toContain('mcpIds');
      expect(file).not.toContain('mcpConfigs');
    });
  });

  describe('parsePersonaFile', () => {
    it('treats a file without front-matter as pure body', () => {
      const raw = '# Role\n\nNo front-matter here.';
      expect(parsePersonaFile(raw)).toEqual({ settings: {}, body: raw });
    });

    it('tolerates hand-edited unquoted scalar values', () => {
      const raw = '---\nmodel: claude-opus-4-8\nfreeAgentMode: true\n---\n# Body';
      const { settings, body } = parsePersonaFile(raw);
      expect(settings.model).toBe('claude-opus-4-8');
      expect(settings.freeAgentMode).toBe(true);
      expect(body).toBe('# Body');
    });

    it('ignores unknown keys and comment lines', () => {
      const raw = '---\n# a comment\nmodel: "x"\nbogusKey: "y"\n---\nbody';
      const { settings } = parsePersonaFile(raw);
      expect(settings.model).toBe('x');
      expect((settings as Record<string, unknown>).bogusKey).toBeUndefined();
    });
  });

  describe('stripPersonaFrontMatter', () => {
    it('removes the front-matter block', () => {
      const raw = '---\nmodel: "x"\n---\n\n# Role: QA';
      expect(stripPersonaFrontMatter(raw)).toBe('# Role: QA');
    });

    it('returns the input unchanged when there is no front-matter', () => {
      const raw = '# Role: QA\n\nbody';
      expect(stripPersonaFrontMatter(raw)).toBe(raw);
    });
  });
});
