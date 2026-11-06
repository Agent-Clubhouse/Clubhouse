import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import minimatch from 'minimatch';

describe('Copilot test discovery', () => {
  it('runs the fake tests in the standard main project and reserves runtime QA for its explicit config', () => {
    const standard = 'src/main/**/*.test.ts';
    const mainConfig = fs.readFileSync(path.resolve('vitest.config.ts'), 'utf8');
    expect(mainConfig).toContain(standard);
    expect(minimatch('src/main/chat/copilot/driver.test.ts', standard)).toBe(true);
    expect(minimatch('src/main/chat/copilot/fixture-replay.test.ts', standard)).toBe(true);
    expect(minimatch('src/main/chat/copilot/driver.runtime.qa.ts', standard)).toBe(false);
    const config = fs.readFileSync(path.resolve('vitest.copilot-runtime.config.ts'), 'utf8');
    expect(config).toContain('src/main/chat/copilot/driver.runtime.qa.ts');
  });
});
