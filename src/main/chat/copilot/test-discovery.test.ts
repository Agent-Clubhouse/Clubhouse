import { describe, expect, it } from 'vitest';
import minimatch from 'minimatch';
import config from '../../../../vitest.config';
import qaConfig from '../../../../vitest.copilot-runtime.config';

// Vitest's default include if a project does not provide one. Fail closed on
// unsupported project forms: a new config must be reviewed, not overlooked.
const defaultInclude = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const qa = 'src/main/chat/copilot/driver.runtime.qa.ts';
const matches = (file: string, patterns: string[]) => patterns.some((pattern) => minimatch(file, pattern, { dot: true }));

describe('Copilot test discovery', () => {
  it('keeps runtime QA out of every configured standard project', () => {
    const projects = config.test?.projects;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects?.length).toBeGreaterThan(0);
    let sawMain = false;
    for (const project of projects!) {
      // A project path or factory can hide arbitrary discovery rules.
      expect(typeof project).toBe('object');
      expect(project && 'test' in project).toBe(true);
      const entry = project as { root?: string; test: { name?: string; include?: string[]; exclude?: string[]; includeSource?: string[]; typecheck?: { enabled?: boolean }; root?: string } };
      const test = entry.test;
      expect(entry.root).toBeUndefined();
      expect(test.root).toBeUndefined();
      expect(test.includeSource ?? []).toEqual([]);
      expect(test.typecheck?.enabled ?? false).toBe(false);
      const include = test.include ?? defaultInclude;
      const exclude = test.exclude ?? [];
      expect(matches(qa, include) && !matches(qa, exclude), `QA discovered by ${test.name}`).toBe(false);
      if (test.name === 'main') {
        sawMain = true;
        expect(matches('src/main/chat/copilot/driver.test.ts', include)).toBe(true);
        expect(matches('src/main/chat/copilot/fixture-replay.test.ts', include)).toBe(true);
      }
    }
    expect(sawMain).toBe(true);
    expect(matches(qa, qaConfig.test?.include ?? defaultInclude)).toBe(true);
    expect(matches(qa, qaConfig.test?.exclude ?? [])).toBe(false);
  });
});
