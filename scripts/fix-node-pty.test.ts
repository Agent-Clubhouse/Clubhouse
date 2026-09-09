import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('fix-node-pty darwin patch', () => {
  const originalPlatform = process.platform;
  const originalExit = process.exit;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.exit = originalExit;
  });

  it('marks both darwin helper binaries executable', async () => {
    const scriptPath = fileURLToPath(new URL('./fix-node-pty.js', import.meta.url));
    const scriptSource = await fs.promises.readFile(scriptPath, 'utf8');
    const chmodCalls: Array<[string, number]> = [];
    const fakeFs = {
      existsSync: (target: string) => {
        const helper = String(target);
        return helper.includes('/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper') || helper.includes('/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper');
      },
      chmodSync: (target: string, mode: number) => {
        chmodCalls.push([String(target), Number(mode)]);
      },
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    };
    const fakeProcess = {
      ...process,
      platform: 'darwin',
      exit: vi.fn(),
    } as typeof process & { platform: string; exit: typeof process.exit };

    const requireFromScript = (id: string) => {
      if (id === 'fs') return fakeFs;
      if (id === 'path') return path;
      throw new Error(`Unexpected require in fix-node-pty.js: ${id}`);
    };

    const module = { exports: {} };
    const runner = new Function('require', 'module', 'exports', '__dirname', 'process', scriptSource);
    runner(requireFromScript, module, module.exports, path.dirname(scriptPath), fakeProcess);

    expect(chmodCalls).toEqual([
      [expect.stringContaining('darwin-arm64/spawn-helper'), 0o755],
      [expect.stringContaining('darwin-x64/spawn-helper'), 0o755],
    ]);
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
  });
});
