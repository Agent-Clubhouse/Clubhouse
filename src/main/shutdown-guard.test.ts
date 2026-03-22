import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural tests verifying the before-quit handler properly awaits async cleanup.
 * The actual Electron event handling can't be unit-tested without mocking the full
 * Electron runtime, so we verify the source structure instead.
 */

const indexSource = fs.readFileSync(
  path.resolve(__dirname, 'index.ts'),
  'utf-8',
);

describe('before-quit handler', () => {
  it('should use event.preventDefault() to delay quit', () => {
    expect(indexSource).toContain('event.preventDefault()');
  });

  it('should have a re-entrance guard', () => {
    expect(indexSource).toContain('isQuitting');
  });

  it('should await killAll via Promise', () => {
    // killAll should be inside a Promise.all or awaited
    expect(indexSource).toMatch(/Promise\.all\(\s*\[[\s\S]*?killAll\(\)/);
  });

  it('should await flushAllAgentConfigs via Promise', () => {
    expect(indexSource).toMatch(/Promise\.all\(\s*\[[\s\S]*?flushAllAgentConfigs\(\)/);
  });

  it('should call app.quit() in the finally block', () => {
    expect(indexSource).toMatch(/\.finally\(\s*\(\)\s*=>\s*\{[\s\S]*?app\.quit\(\)/);
  });
});
