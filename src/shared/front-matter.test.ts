import { describe, it, expect } from 'vitest';
import { frontMatterLaunchSettings, readFrontMatterValue, stripFrontMatter } from './front-matter';

describe('front-matter', () => {
  describe('frontMatterLaunchSettings', () => {
    it('is empty for a file without front matter', () => {
      expect(frontMatterLaunchSettings('# Role\n\nNo front matter here.')).toEqual([]);
    });

    it('lists the launch settings, tolerating unquoted scalars', () => {
      const raw = '---\nmodel: claude-opus-4-8\nfreeAgentMode: true\nskills: [{"name": "mission"}]\n---\n# Body';
      expect(frontMatterLaunchSettings(raw)).toEqual(['model', 'freeAgentMode', 'skills']);
    });

    it('ignores unknown keys, comment lines and empty values', () => {
      expect(frontMatterLaunchSettings('---\n# a comment\nbogusKey: "y"\nmodel:\n---\nbody')).toEqual([]);
    });

    it('counts orchestration only when it holds a valid field', () => {
      expect(frontMatterLaunchSettings('---\norchestration: {"orchestrate": true, "bogus": 1}\n---\n\nbody')).toEqual(['orchestration']);
      expect(frontMatterLaunchSettings('---\norchestration: {"bogus": 1}\n---\n\nbody')).toEqual([]);
    });
  });

  describe('stripFrontMatter', () => {
    it('removes the front-matter block', () => {
      expect(stripFrontMatter('---\nmodel: "x"\n---\n\n# Role: QA')).toBe('# Role: QA');
    });

    it('returns the input unchanged when there is no front matter', () => {
      const raw = '# Role: QA\n\nbody';
      expect(stripFrontMatter(raw)).toBe(raw);
    });
  });

  describe('readFrontMatterValue', () => {
    it('reads a key as JSON', () => {
      const raw = '---\nmodel: opus\norchestration: {"orchestrate": true, "maxHelpers": 3}\n---\n\nbody';
      expect(readFrontMatterValue(raw, 'orchestration')).toEqual({ orchestrate: true, maxHelpers: 3 });
      expect(readFrontMatterValue(raw, 'model')).toBe('opus');
    });

    it('handles CRLF files', () => {
      const raw = '---\r\norchestration: {"control": "ask-everything"}\r\n---\r\n\r\nbody';
      expect(readFrontMatterValue(raw, 'orchestration')).toEqual({ control: 'ask-everything' });
    });

    it('returns undefined without front matter or the key', () => {
      expect(readFrontMatterValue('# body', 'orchestration')).toBeUndefined();
      expect(readFrontMatterValue('---\nmodel: opus\n---\n\nbody', 'orchestration')).toBeUndefined();
    });
  });
});
