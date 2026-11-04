import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Runs scripts/ci/release-publish.sh against fake `az` and `gh` binaries. A
 * directory stands in for the storage container, so nothing here can reach real
 * storage or a real GitHub release. The fakes prove the order of writes and what
 * a failure leaves behind. They can't prove how the real CLIs behave: see
 * docs/release-publishing.md.
 */

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(__dirname, 'release-publish.sh');
const WORKFLOW = path.join(REPO, '.github/workflows/release.yml');
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8');
const WORKFLOW_TEXT = readFileSync(WORKFLOW, 'utf8');

const FAKES = path.join(__dirname, '__fixtures__/release-publish');

const STABLE = '0.42.0';
const BETA = '0.42.0-beta.14';
const ARTIFACTS = [
  'darwin-arm64.zip', 'darwin-arm64.dmg', 'darwin-x64.zip', 'darwin-x64.dmg',
  'win32-x64-Setup.exe', 'win32-arm64-Setup.exe', 'linux-x64.deb', 'linux-x64.rpm',
];

/** One release run's world: fake CLIs, a fake container and built artifacts. */
class Sandbox {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-'));
  store = path.join(this.dir, 'store');
  work = path.join(this.dir, 'work');
  bin = path.join(this.dir, 'bin');
  writesFile = path.join(this.dir, 'writes');
  callsFile = path.join(this.dir, 'calls');
  lastOutput = '';

  constructor(public version: string, public preview: boolean, previewVersion = '0.42.0-beta.13') {
    fs.mkdirSync(this.bin);
    for (const fake of ['az', 'gh']) {
      fs.copyFileSync(path.join(FAKES, fake), path.join(this.bin, fake));
      fs.chmodSync(path.join(this.bin, fake), 0o755);
    }
    fs.writeFileSync(this.writesFile, '');
    fs.writeFileSync(this.callsFile, '');

    const artifacts = path.join(this.work, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const name of ARTIFACTS) {
      fs.writeFileSync(path.join(artifacts, `Clubhouse-${version}-${name}`), `${version} ${name}`);
    }
    for (const arch of ['x64', 'arm64']) {
      const squirrel = path.join(artifacts, `squirrel-win32-${arch}`);
      fs.mkdirSync(squirrel);
      fs.writeFileSync(path.join(squirrel, 'RELEASES'), `${version} ${arch}`);
      fs.writeFileSync(path.join(squirrel, `clubhouse-${version}-full.nupkg`), `${version} ${arch} nupkg`);
    }
    const manifest = JSON.stringify({ version });
    fs.writeFileSync(path.join(artifacts, preview ? 'preview.json' : 'latest.json'), manifest);

    this.seed('updates/v2/history.json', JSON.stringify([{ version: '0.41.0' }, { version: '0.40.0' }]));
    this.seed('updates/v2/latest.json', JSON.stringify({ version: '0.41.0' }));
    this.seed('updates/latest.json', JSON.stringify({ version: '0.41.0' }));
    this.seed('updates/v2/preview.json', JSON.stringify({ version: previewVersion }));
  }

  seed(blob: string, content: string) {
    const file = path.join(this.store, blob);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  blob(blob: string): string | null {
    const file = path.join(this.store, blob);
    return fs.existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  liveVersion(blob: string): string {
    return JSON.parse(this.blob(blob) ?? '{}').version;
  }

  run(env: Record<string, string> = {}) {
    // A clean environment: no Azure or GitHub credentials, and the fakes first on PATH.
    const result = spawnSync('bash', [SCRIPT], {
      cwd: this.work,
      encoding: 'utf8',
      env: {
        PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
        STORE: this.store,
        WRITES: this.writesFile,
        CALLS: this.callsFile,
        VERSION: this.version,
        IS_PREVIEW: String(this.preview),
        GITHUB_REPOSITORY: 'example/fake',
        RELEASE_MESSAGE: 'Message',
        RELEASE_NOTES: '# New Features\n- Notes',
        ...env,
      },
    });
    this.lastOutput = `${result.stdout}${result.stderr}`;
    return result.status;
  }

  writes(): string[] {
    return readFileSync(this.writesFile, 'utf8').split('\n').filter(Boolean);
  }

  calls(): string[] {
    return readFileSync(this.callsFile, 'utf8').split('\n').filter(Boolean);
  }

  clearWrites() {
    fs.writeFileSync(this.writesFile, '');
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const HAS_JQ = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;
// jq is on every CI runner; a laptop without it skips rather than failing.
const CAN_RUN = process.platform !== 'win32' && (HAS_JQ || Boolean(process.env.CI));

// Each run starts about 60 processes, which is slow on a loaded runner.
describe.skipIf(!CAN_RUN)('release-publish.sh against fake az and gh', { timeout: 60_000 }, () => {
  let sandboxes: Sandbox[] = [];
  const sandbox = (version: string, preview: boolean, previewVersion?: string) => {
    const s = new Sandbox(version, preview, previewVersion);
    sandboxes.push(s);
    return s;
  };

  beforeEach(() => {
    sandboxes = [];
  });

  afterEach(() => {
    for (const s of sandboxes) s.cleanup();
  });

  describe('A: a clean stable run', () => {
    it('publishes everything a manifest points at before the manifest', () => {
      const s = sandbox(STABLE, false);
      expect(s.run()).toBe(0);
      const writes = s.writes();
      const at = (entry: string) => {
        const index = writes.indexOf(entry);
        expect(index, entry).toBeGreaterThanOrEqual(0);
        return index;
      };

      const lastArtifact = Math.max(...ARTIFACTS.map((a) => at(`upload artifacts/Clubhouse-${STABLE}-${a}`)));
      const stableFeed = (arch: string) => at(`upload squirrel/stable/win32-${arch}/RELEASES`);
      const previewFeed = (arch: string) => at(`upload squirrel/preview/win32-${arch}/RELEASES`);
      const firstSquirrel = writes.findIndex((w) => w.includes('squirrel/'));

      expect(lastArtifact).toBeLessThan(firstSquirrel);
      for (const arch of ['x64', 'arm64']) {
        expect(at(`upload squirrel/stable/win32-${arch}/clubhouse-${STABLE}-full.nupkg`)).toBeLessThan(stableFeed(arch));
        expect(at(`upload squirrel/preview/win32-${arch}/clubhouse-${STABLE}-full.nupkg`)).toBeLessThan(previewFeed(arch));
        expect(stableFeed(arch)).toBeLessThan(previewFeed(arch));
      }
      const firstSlot = writes.findIndex((w) => w.startsWith('copy latest/'));
      expect(previewFeed('arm64')).toBeLessThan(firstSlot);
      expect(at('copy latest/Clubhouse-latest-linux-x64.rpm')).toBeLessThan(at('gh-create'));
      expect(at('gh-create')).toBeLessThan(at('upload updates/v2/history.json'));
      expect(at('upload updates/v2/history.json')).toBeLessThan(at('upload updates/history.json'));
      expect(at('upload updates/history.json')).toBeLessThan(at('upload updates/latest.json'));
      expect(writes.at(-1)).toBe('upload updates/v2/latest.json');
    });

    it('leaves the published state a client reads', () => {
      const s = sandbox(STABLE, false);
      expect(s.run()).toBe(0);
      expect(s.liveVersion('updates/v2/latest.json')).toBe(STABLE);
      expect(s.liveVersion('updates/latest.json')).toBe(STABLE);
      expect(s.blob('squirrel/stable/win32-x64/RELEASES')).toBe(`${STABLE} x64`);
      expect(s.blob('squirrel/preview/win32-arm64/RELEASES')).toBe(`${STABLE} arm64`);
      expect(s.blob('latest/Clubhouse-latest-darwin-arm64.dmg')).toBe(`${STABLE} darwin-arm64.dmg`);
      const history = JSON.parse(s.blob('updates/v2/history.json') ?? '[]');
      expect(history.map((e: { version: string }) => e.version)).toEqual([STABLE, '0.41.0', '0.40.0']);
      expect(s.blob('updates/history.json')).toBe(s.blob('updates/v2/history.json'));
    });

    it('passes shell-special release text through literally', () => {
      const s = sandbox(STABLE, false);
      const text = 'A "quoted" `thing` with $(touch hacked) and \'quotes\'';
      expect(s.run({ RELEASE_MESSAGE: text, RELEASE_NOTES: text })).toBe(0);
      expect(s.blob('.github-release')).toBe(`v${STABLE} — ${text}\n${text}\n`);
      expect(JSON.parse(s.blob('updates/v2/history.json') ?? '[]')[0].releaseNotes).toBe(text);
      expect(fs.existsSync(path.join(s.work, 'hacked'))).toBe(false);
    });
  });

  describe('B: a re-run after a complete run', () => {
    it('succeeds, leaves artifacts alone and updates the GitHub release', () => {
      const s = sandbox(STABLE, false);
      expect(s.run()).toBe(0);
      s.clearWrites();

      expect(s.run()).toBe(0);
      const writes = s.writes();
      expect(writes.filter((w) => w.startsWith('upload artifacts/'))).toEqual([]);
      expect(writes).toContain('gh-upload');
      expect(writes).not.toContain('gh-create');
      expect(writes.at(-1)).toBe('upload updates/v2/latest.json');
      expect(JSON.parse(s.blob('updates/v2/history.json') ?? '[]')).toHaveLength(3);
    });
  });

  describe('C: a failure at each point', () => {
    it.each([
      ['an artifact upload', `--name artifacts/Clubhouse-${STABLE}-linux-x64.deb --file`],
      ['a stable feed package', `squirrel/stable/win32-x64/clubhouse-${STABLE}-full.nupkg`],
      ['a stable feed RELEASES', 'squirrel/stable/win32-arm64/RELEASES'],
      ['a preview feed RELEASES', 'squirrel/preview/win32-x64/RELEASES'],
      ['a slot copy', 'blob copy start'],
      ['the slot copy wait', 'blob show'],
      ['the GitHub release', 'release create'],
      ['the history upload', '--name updates/v2/history.json --file artifacts'],
      ['the legacy manifest', '--name updates/latest.json --file'],
      ['the v2 manifest', '--name updates/v2/latest.json --file'],
    ])('%s: the old version stays live, and a re-run finishes', (_label, match) => {
      const s = sandbox(STABLE, false);
      expect(s.run({ FAIL_MATCH: match })).not.toBe(0);
      expect(s.liveVersion('updates/v2/latest.json')).toBe('0.41.0');

      expect(s.run()).toBe(0);
      expect(s.liveVersion('updates/v2/latest.json')).toBe(STABLE);
      expect(s.writes().at(-1)).toBe('upload updates/v2/latest.json');
    });

    it('never names a feed package it has not uploaded', () => {
      const s = sandbox(STABLE, false);
      expect(s.run({ FAIL_MATCH: `squirrel/stable/win32-x64/clubhouse-${STABLE}-full.nupkg` })).not.toBe(0);
      expect(s.blob('squirrel/stable/win32-x64/RELEASES')).toBeNull();
    });
  });

  describe('D to G: history', () => {
    const existing = JSON.stringify([{ version: '0.41.0' }, { version: '0.40.0' }]);

    it('D: a failed download stops the run with nothing written', () => {
      const s = sandbox(STABLE, false);
      expect(s.run({ FAIL_MATCH: 'blob download --account-name stclubhousereleases --container-name releases --auth-mode login --name updates/v2/history.json' })).not.toBe(0);
      expect(s.writes()).toEqual([]);
      expect(s.blob('updates/v2/history.json')).toBe(existing);
    });

    it('E: a missing file stops the run instead of starting a new history', () => {
      const s = sandbox(STABLE, false);
      fs.rmSync(path.join(s.store, 'updates/v2/history.json'));
      expect(s.run()).not.toBe(0);
      expect(s.lastOutput).toContain('updates/v2/history.json is missing');
      expect(s.writes()).toEqual([]);
      expect(s.blob('updates/v2/history.json')).toBeNull();
    });

    it.each([['an object', '{}'], ['an empty array', '[]'], ['not JSON', 'nope']])('F: %s stops the run', (_label, content) => {
      const s = sandbox(STABLE, false);
      s.seed('updates/v2/history.json', content);
      expect(s.run()).not.toBe(0);
      expect(s.writes()).toEqual([]);
      expect(s.blob('updates/v2/history.json')).toBe(content);
    });

    it('G: a failed lookup stops the run, and is not reported as missing', () => {
      const s = sandbox(STABLE, false);
      expect(s.run({ FAIL_MATCH: 'blob exists --account-name stclubhousereleases --container-name releases --auth-mode login --name updates/v2/history.json' })).not.toBe(0);
      expect(s.lastOutput).not.toContain('is missing');
      expect(s.writes()).toEqual([]);
      expect(s.blob('updates/v2/history.json')).toBe(existing);
    });
  });

  describe('H: an artifact already published with different bytes', () => {
    it('stops the run before the manifest', () => {
      const s = sandbox(STABLE, false);
      s.seed(`artifacts/Clubhouse-${STABLE}-darwin-arm64.zip`, 'other bytes');
      expect(s.run()).not.toBe(0);
      expect(s.lastOutput).toContain('already exists with different bytes');
      expect(s.blob(`artifacts/Clubhouse-${STABLE}-darwin-arm64.zip`)).toBe('other bytes');
      expect(s.liveVersion('updates/v2/latest.json')).toBe('0.41.0');
    });
  });

  describe('I and J: publishing stable to the preview feed', () => {
    it('I: skips the preview feed when preview has moved past this version', () => {
      const s = sandbox('0.42.1', false, '0.43.0-beta.1');
      expect(s.run()).toBe(0);
      expect(s.writes().filter((w) => w.includes('squirrel/preview'))).toEqual([]);
      expect(s.writes().at(-1)).toBe('upload updates/v2/latest.json');
    });

    it('J: writes the preview feed when preview is on the same base version', () => {
      const s = sandbox(STABLE, false, '0.42.0-beta.13');
      expect(s.run()).toBe(0);
      expect(s.blob('squirrel/preview/win32-x64/RELEASES')).toBe(`${STABLE} x64`);
      expect(s.blob('squirrel/preview/win32-arm64/RELEASES')).toBe(`${STABLE} arm64`);
    });

    it('writes the preview feed when preview is on an older base version', () => {
      const s = sandbox(STABLE, false, '0.41.0-beta.12');
      expect(s.run()).toBe(0);
      expect(s.blob('squirrel/preview/win32-x64/RELEASES')).toBe(`${STABLE} x64`);
    });

    it('stops with nothing written when the preview version cannot be read', () => {
      const failed = sandbox(STABLE, false);
      expect(failed.run({ FAIL_MATCH: '--name updates/v2/preview.json' })).not.toBe(0);
      expect(failed.writes()).toEqual([]);

      const corrupt = sandbox(STABLE, false);
      corrupt.seed('updates/v2/preview.json', '{}');
      expect(corrupt.run()).not.toBe(0);
      expect(corrupt.writes()).toEqual([]);
    });
  });

  describe('K: a clean beta run', () => {
    it('writes preview blobs only, with the v2 manifest last', () => {
      const s = sandbox(BETA, true);
      const latest = s.blob('updates/v2/latest.json');
      const history = s.blob('updates/v2/history.json');
      expect(s.run()).toBe(0);
      const writes = s.writes();

      expect(writes.at(-1)).toBe('upload updates/v2/preview.json');
      expect(writes.at(-2)).toBe('upload updates/preview.json');
      expect(writes).toContain('gh-create prerelease');
      expect(writes.filter((w) => w.includes('squirrel/stable'))).toEqual([]);
      expect(writes.filter((w) => w.includes('history'))).toEqual([]);
      expect(writes.filter((w) => w.includes('latest'))).toEqual([]);
      expect(s.blob('updates/v2/latest.json')).toBe(latest);
      expect(s.blob('updates/v2/history.json')).toBe(history);
      expect(s.blob('preview/Clubhouse-preview-win32-x64-Setup.exe')).toBe(`${BETA} win32-x64-Setup.exe`);
      expect(s.calls().some((c) => c.includes('blob download'))).toBe(false);
    });

    it('seeds v2/latest.json from the legacy path when it is missing, still with preview last', () => {
      const s = sandbox(BETA, true);
      fs.rmSync(path.join(s.store, 'updates/v2/latest.json'));
      expect(s.run()).toBe(0);
      expect(s.liveVersion('updates/v2/latest.json')).toBe('0.41.0');
      expect(s.writes()).toContain('copy updates/v2/latest.json');
      expect(s.writes().at(-1)).toBe('upload updates/v2/preview.json');
    });
  });

  describe('missing Squirrel output', () => {
    // A deliberate change for betas too: this used to be a warning, leaving a
    // manifest that Windows clients couldn't act on.
    it.each([[BETA, true], [STABLE, false]] as const)('%s stops with nothing written', (version, preview) => {
      const s = sandbox(version, preview);
      fs.rmSync(path.join(s.work, 'artifacts/squirrel-win32-arm64'), { recursive: true });
      expect(s.run()).not.toBe(0);
      expect(s.lastOutput).toContain('No Squirrel files for win32-arm64');
      expect(s.writes()).toEqual([]);
    });

    it('stops when RELEASES has no package beside it', () => {
      const s = sandbox(BETA, true);
      fs.rmSync(path.join(s.work, `artifacts/squirrel-win32-x64/clubhouse-${BETA}-full.nupkg`));
      expect(s.run()).not.toBe(0);
      expect(s.writes()).toEqual([]);
    });
  });

  describe('account and container', () => {
    it('default to the release storage', () => {
      const s = sandbox(STABLE, false);
      expect(s.run()).toBe(0);
      const az = s.calls().filter((c) => c.startsWith('az '));
      expect(az.length).toBeGreaterThan(0);
      for (const call of az) {
        expect(call).toContain('stclubhousereleases');
      }
      for (const call of az.filter((c) => !c.includes('copy start'))) {
        expect(call).toContain('--container-name releases');
      }
    });

    it('can be overridden, which here only reaches the fake', () => {
      const s = sandbox(STABLE, false);
      expect(s.run({ RELEASE_ACCOUNT: 'fakeaccount', RELEASE_CONTAINER: 'fakecontainer' })).toBe(0);
      const az = s.calls().filter((c) => c.startsWith('az '));
      for (const call of az) {
        expect(call).toContain('fakeaccount');
        expect(call).not.toContain('stclubhousereleases');
      }
    });
  });

  describe('required input', () => {
    it.each(['VERSION', 'IS_PREVIEW', 'GITHUB_REPOSITORY'])('stops without %s', (name) => {
      const s = sandbox(STABLE, false);
      expect(s.run({ [name]: '' })).not.toBe(0);
      expect(s.calls()).toEqual([]);
    });
  });
});

describe('release.yml publish wiring', () => {
  const WRITE = /^\s*(?:upload_mutable|upload_immutable|publish_squirrel_feed|az storage blob (?:upload|copy start)|gh release (?:create|upload))\b/;
  const scriptLines = SCRIPT_TEXT.split(/\r?\n/);

  /** Lines that write something, after the function definitions. */
  function writesAfterPreflight(): string[] {
    const start = scriptLines.findIndex((l) => l.startsWith('# 1. Versioned artifacts'));
    return scriptLines.slice(start).filter((l) => WRITE.test(l));
  }

  it('has no inline storage or release commands left', () => {
    expect(WORKFLOW_TEXT).not.toMatch(/\baz storage\b/);
    expect(WORKFLOW_TEXT).not.toMatch(/\bgh release\b/);
    expect(WORKFLOW_TEXT).toContain('run: bash scripts/ci/release-publish.sh');
  });

  it('checks out the repo before running the script in the publish job', () => {
    const publish = WORKFLOW_TEXT.slice(WORKFLOW_TEXT.indexOf('\n  publish:'));
    expect(publish.indexOf('actions/checkout')).toBeGreaterThan(-1);
    expect(publish.indexOf('actions/checkout')).toBeLessThan(publish.indexOf('run: bash scripts/ci/release-publish.sh'));
    expect(publish.indexOf('azure/login')).toBeLessThan(publish.indexOf('run: bash scripts/ci/release-publish.sh'));
  });

  it('makes the v2 manifest the last write of each kind of release', () => {
    const writes = writesAfterPreflight();
    expect(writes.at(-1)?.trim()).toBe('upload_mutable artifacts/latest.json "updates/v2/latest.json" application/json');
    const elseIndex = writes.findIndex((l) => l.includes('artifacts/history.json'));
    expect(writes[elseIndex - 1]?.trim()).toBe('upload_mutable artifacts/preview.json "updates/v2/preview.json" application/json');
  });

  it('keeps publishing with the release storage by default', () => {
    expect(SCRIPT_TEXT).toContain('ACCOUNT="${RELEASE_ACCOUNT:-stclubhousereleases}"');
    expect(SCRIPT_TEXT).toContain('CONTAINER="${RELEASE_CONTAINER:-releases}"');
  });
});

describe('release.yml tag parsing', () => {
  const start = WORKFLOW_TEXT.indexOf('# Only these tag shapes are releases');
  const end = WORKFLOW_TEXT.indexOf('# Verify tag version matches package.json');
  const block = WORKFLOW_TEXT.slice(start, end).split(/\r?\n/).map((l) => l.replace(/^ {10}/, '')).join('\n');

  function classify(version: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
    const output = path.join(dir, 'output');
    fs.writeFileSync(output, '');
    try {
      const result = spawnSync('bash', ['-e', '-c', block], {
        encoding: 'utf8',
        env: { VERSION: version, GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: output, PATH: process.env.PATH },
      });
      if (result.status !== 0) return 'rejected';
      return readFileSync(output, 'utf8').trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === 'win32').each([
    ['0.42.0', 'is_preview=false'],
    ['0.42.1', 'is_preview=false'],
    ['1.0.0', 'is_preview=false'],
    ['0.42.0-beta.14', 'is_preview=true'],
    ['0.42.0-beta.1', 'is_preview=true'],
    ['0.33.1rc', 'is_preview=true'],
    ['0.42.0-rc.1', 'rejected'],
    ['0.42.0-RC1', 'rejected'],
    ['0.42.0-beta', 'rejected'],
    ['0.42.0-beta.1x', 'rejected'],
    ['0.42', 'rejected'],
    ['1.0.0-alpha.1', 'rejected'],
  ])('%s gives %s', (version, expected) => {
    expect(classify(version)).toBe(expected);
  });
});
