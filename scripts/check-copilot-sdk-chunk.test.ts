/**
 * The leak rules of scripts/check-copilot-sdk-chunk.mjs. The check itself builds
 * the main bundle, so it has its own CI job on each OS (`copilot-sdk-chunk` in
 * validate.yml) rather than lengthening a unit shard. Run it here with
 * CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK=1, or `node scripts/check-copilot-sdk-chunk.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { checkCopilotSdkChunk, findLeakedAssets, findLeakedModules, LIMIT_BYTES } from './check-copilot-sdk-chunk.mjs';

describe('Copilot SDK chunk leak rules', () => {
  it('flags CLI and native binaries among the emitted assets', () => {
    const leaks = [
      'native_modules/darwin_arm64/koffi.node',
      'native_modules/index.js',
      'koffi.node',
      'runtime.node',
      'prebuilds/win32-x64/copilot-runtime.exe',
      'copilot-runtime',
      '@github/copilot-sdk-linux-x64/package.json',
      'libmsalruntime_arm64.dylib',
      'msalruntime.dll',
      'something.so',
    ];
    expect(findLeakedAssets(leaks)).toEqual(leaks);
  });

  it('passes the chunks a clean build emits', () => {
    expect(findLeakedAssets(['main.js', 'github-copilot-sdk.js', 'sdk-bundle-smoke.js', '123.js'])).toEqual([]);
  });

  it('flags koffi and the platform packages among the bundled modules, on either path separator', () => {
    const leaks = [
      '/repo/node_modules/koffi/index.js',
      '/repo/node_modules/@koromix/koffi-linux-x64/index.js',
      'C:\\repo\\node_modules\\koffi\\index.cjs',
      'C:\\repo\\node_modules\\@github\\copilot-sdk-win32-x64\\index.js',
    ];
    expect(findLeakedModules(leaks)).toEqual(leaks);
  });

  it('passes the SDK itself', () => {
    expect(findLeakedModules(['/repo/node_modules/@github/copilot-sdk/dist/index.js', 'C:\\repo\\node_modules\\zod\\index.js'])).toEqual([]);
  });
});

describe.skipIf(process.env.CLUBHOUSE_CHECK_COPILOT_SDK_CHUNK !== '1')('Copilot SDK chunk', () => {
  it('bundles the SDK as a lazy chunk without binaries, and the chunk runs', async () => {
    const { report, failures } = await checkCopilotSdkChunk();
    expect(failures).toEqual([]);
    expect(report.sdkBytes).toBeLessThanOrEqual(LIMIT_BYTES);
  }, 300_000);
});
