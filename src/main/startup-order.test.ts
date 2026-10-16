import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// index.ts runs Electron side effects at import time, so the ordering is
// checked against the source rather than by importing it.
const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');

describe('main startup ordering', () => {
  it('decides safe mode before registerAllHandlers() initializes trusted manifests (#1575)', () => {
    const readyStart = source.indexOf("app.on('ready'");
    expect(readyStart).toBeGreaterThan(-1);
    const ready = source.slice(readyStart);

    // Match the call statements, not mentions in comments.
    const safeModeCall = ready.search(/^\s*safeMode\.handleSafeModeStartup\(\);/m);
    const registerCall = ready.search(/^\s*registerAllHandlers\(\);/m);

    expect(safeModeCall).toBeGreaterThan(-1);
    expect(registerCall).toBeGreaterThan(-1);
    expect(safeModeCall).toBeLessThan(registerCall);
    // Exactly one call, so a stale late call can't sneak back in.
    expect(source.match(/^\s*safeMode\.handleSafeModeStartup\(\);/gm)).toHaveLength(1);
  });
});
