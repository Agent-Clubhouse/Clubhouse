import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
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
const DENYLIST_SCRIPT = path.join(__dirname, 'publish-cli-denylist.sh');
const DENYLIST_WORKFLOW_TEXT = readFileSync(path.join(REPO, '.github/workflows/publish-cli-denylist.yml'), 'utf8');

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
    for (const fake of ['az', 'gh', 'curl']) {
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

  run(env: Record<string, string> = {}, script = SCRIPT) {
    // A clean environment: no Azure or GitHub credentials, and the fakes first on PATH.
    const result = spawnSync('bash', [script], {
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

// Each test runs a real script or the real workflow step against the fakes above.
describe.skipIf(!CAN_RUN)('chat CLI denylist', { timeout: 60_000 }, () => {
  const ENTRY = { provider: 'claude-code', versions: ['2.1.250'], reason: 'hangs on start' };
  const LATER = { driver: 'codex_app_server', versions: ['0.166.0'], reason: 'drops the session' };
  const STABLE_BLOBS = ['updates/latest.json', 'updates/v2/latest.json'];
  const PREVIEW_BLOBS = ['updates/preview.json', 'updates/v2/preview.json'];
  const ALL_BLOBS = [...STABLE_BLOBS, ...PREVIEW_BLOBS];
  const UPLOADS = ALL_BLOBS.map((b) => `upload ${b}`);
  const PUBLISH = { GITHUB_REF: 'refs/heads/main', DRY_RUN: 'false' };

  /** Bytes a rewrite has to leave alone: an escape, a non-ASCII letter, a number's exact form. */
  const manifestBytes = (blob: string) => `{\n  "version": "0.41.0",\n  "releaseNotes": "caf\u00e9 \\"${blob}\\" \\u2014",\n  "artifacts": {"a": {"size": 1.50}}\n}\n`;
  const withList = (before: string, list: unknown) => before.replace('\n}\n', `,\n  "chatCliDenylist": ${JSON.stringify(list)}\n}\n`);
  const liveList = (s: Sandbox, blob: string) => JSON.parse(s.blob(blob) ?? '{}').chatCliDenylist;

  let sandboxes: Sandbox[] = [];
  const sandbox = (list: unknown, version = STABLE, preview = false) => {
    const s = new Sandbox(version, preview);
    sandboxes.push(s);
    for (const blob of ALL_BLOBS) s.seed(blob, manifestBytes(blob));
    writeList(s, list);
    return s;
  };
  const writeList = (s: Sandbox, list: unknown) => {
    fs.mkdirSync(path.join(s.work, 'release'), { recursive: true });
    fs.writeFileSync(path.join(s.work, 'release/chat-cli-denylist.json'), `${JSON.stringify(list)}\n`);
  };
  const publish = (s: Sandbox, env: Record<string, string> = {}) => s.run({ ...PUBLISH, ...env }, DENYLIST_SCRIPT);

  beforeEach(() => {
    sandboxes = [];
  });

  afterEach(() => {
    for (const s of sandboxes) s.cleanup();
  });

  describe('publishing', () => {
    it('changes only the field, on both manifests of both channels, legacy path first', () => {
      const s = sandbox([ENTRY]);
      const history = s.blob('updates/v2/history.json');
      expect(publish(s)).toBe(0);
      expect(s.writes()).toEqual(UPLOADS);
      for (const blob of ALL_BLOBS) {
        expect(s.blob(blob)).toBe(withList(manifestBytes(blob), [ENTRY]));
      }
      expect(s.blob('updates/v2/history.json')).toBe(history);
    });

    it('replaces a list that is already there, in place', () => {
      const s = sandbox([ENTRY, LATER]);
      const before = (blob: string) => `{\n  "version": "0.41.0",\n  "chatCliDenylist": ${JSON.stringify([ENTRY])},\n  "minVersion": "0.1.0"\n}\n`.replace('0.41.0', blob);
      for (const blob of ALL_BLOBS) s.seed(blob, before(blob));
      expect(publish(s)).toBe(0);
      for (const blob of ALL_BLOBS) {
        expect(s.blob(blob)).toBe(before(blob).replace(JSON.stringify([ENTRY]), JSON.stringify([ENTRY, LATER])));
      }
    });

    it('writes nothing when every manifest already has the list', () => {
      const s = sandbox([ENTRY]);
      expect(publish(s)).toBe(0);
      s.clearWrites();
      expect(publish(s)).toBe(0);
      expect(s.writes()).toEqual([]);
    });

    it('a failure part way leaves the rest alone, and a re-run writes only what is left', () => {
      const s = sandbox([ENTRY]);
      expect(publish(s, { FAIL_MATCH: 'blob upload --account-name stclubhousereleases --container-name releases --auth-mode login --name updates/preview.json' })).not.toBe(0);
      expect(s.writes()).toEqual(STABLE_BLOBS.map((b) => `upload ${b}`));
      expect(s.blob('updates/preview.json')).toBe(manifestBytes('updates/preview.json'));
      s.clearWrites();

      expect(publish(s)).toBe(0);
      expect(s.writes()).toEqual(PREVIEW_BLOBS.map((b) => `upload ${b}`));
      for (const blob of ALL_BLOBS) expect(liveList(s, blob)).toEqual([ENTRY]);
    });

    it.each(ALL_BLOBS)('writes nothing when %s cannot be read', (blob) => {
      const s = sandbox([ENTRY]);
      fs.rmSync(path.join(s.store, blob));
      expect(publish(s)).not.toBe(0);
      expect(s.writes()).toEqual([]);
    });

    it('writes nothing when a manifest is not a manifest', () => {
      const s = sandbox([ENTRY]);
      s.seed('updates/v2/preview.json', '{}');
      expect(publish(s)).not.toBe(0);
      expect(s.writes()).toEqual([]);
    });

    it('fails rather than overwrite a manifest written since it was read', () => {
      const s = sandbox([ENTRY]);
      const blob = 'updates/v2/latest.json';
      expect(publish(s, { RACE_UPLOAD_OF: blob })).not.toBe(0);
      expect(s.blob(blob)).toBe(`${manifestBytes(blob)} `);
      expect(s.writes()).toEqual(['upload updates/latest.json']);
    });

    // The fake gh applies the script's own --jq filter to these runs.
    it.each([
      ['in progress', ['in_progress']],
      ['queued', ['queued']],
      ['waiting', ['waiting']],
      ['requested', ['requested']],
      ['pending', ['pending']],
      ['active among finished ones', ['completed', 'in_progress', 'completed']],
    ])('refuses while a release is %s', (_label, statuses) => {
      const s = sandbox([ENTRY]);
      s.seed('.release-runs', JSON.stringify(statuses.map((status) => ({ status }))));
      expect(publish(s)).not.toBe(0);
      expect(s.lastOutput).toContain('A Release run is in progress');
      expect(s.writes()).toEqual([]);
      expect(s.calls().filter((c) => c.startsWith('az '))).toEqual([]);
    });

    it.each([
      ['every recent release finished', ['completed', 'completed']],
      ['no recent release', []],
    ])('goes ahead with %s', (_label, statuses) => {
      const s = sandbox([ENTRY]);
      s.seed('.release-runs', JSON.stringify(statuses.map((status) => ({ status }))));
      expect(publish(s)).toBe(0);
      expect(s.writes()).toEqual(UPLOADS);
    });

    it.each(ALL_BLOBS)('stops on an empty ETag for %s, rather than passing it to az', (blob) => {
      const s = sandbox([ENTRY]);
      expect(publish(s, { EMPTY_ETAG_OF: blob })).not.toBe(0);
      expect(s.lastOutput).toContain(`No ETag for ${blob}`);
      expect(s.writes()).toEqual([]);
      expect(s.calls().some((c) => c.includes('blob download') && c.includes(`--name ${blob} `))).toBe(false);
      expect(s.calls().some((c) => /--if-match( |$)(--|$)/.test(c))).toBe(false);
    });

    it.each([['a branch', 'refs/heads/some-branch'], ['a tag', 'refs/tags/v1.0.0'], ['no ref', '']])('refuses from %s', (_label, ref) => {
      const s = sandbox([ENTRY]);
      expect(publish(s, { GITHUB_REF: ref })).not.toBe(0);
      expect(s.lastOutput).toContain('runs from main only');
      expect(s.calls()).toEqual([]);
    });

    it.each([
      ['no reason', [{ provider: 'claude-code', versions: ['2.1.250'] }]],
      ['a wildcard version', [{ ...ENTRY, versions: ['2.1.*'] }]],
      ['an unknown provider', [{ ...ENTRY, provider: 'claude' }]],
      ['an object, not a list', { entries: [ENTRY] }],
    ])('a bad list stops the run before it touches anything: %s', (_label, list) => {
      const s = sandbox(list);
      expect(publish(s)).not.toBe(0);
      expect(s.lastOutput).toContain("can't be published");
      expect(s.calls()).toEqual([]);
    });

    it('one bad entry among good ones stops the run', () => {
      const s = sandbox([ENTRY, { ...LATER, reason: '' }]);
      expect(publish(s)).not.toBe(0);
      expect(s.lastOutput).toContain('entry 1 needs a reason');
      expect(s.calls()).toEqual([]);
    });

    it('a null list has nothing to publish', () => {
      const s = sandbox(null);
      expect(publish(s)).not.toBe(0);
      expect(s.lastOutput).toContain('no list to publish');
      expect(s.writes()).toEqual([]);
    });

    it('an empty list is written only on purpose', () => {
      const s = sandbox([]);
      expect(publish(s)).not.toBe(0);
      expect(s.lastOutput).toContain('empties the saved list');
      expect(s.writes()).toEqual([]);

      expect(publish(s, { CLEAR_LIST: 'true' })).toBe(0);
      for (const blob of ALL_BLOBS) expect(s.blob(blob)).toBe(withList(manifestBytes(blob), []));
    });

    it('asks only the fake storage, under the release account by default', () => {
      const s = sandbox([ENTRY]);
      expect(publish(s)).toBe(0);
      const az = s.calls().filter((c) => c.startsWith('az '));
      expect(az.length).toBeGreaterThan(0);
      for (const call of az) expect(call).toContain('--account-name stclubhousereleases --container-name releases');
      expect(az.filter((c) => c.includes('blob upload')).every((c) => c.includes('--if-match') && c.includes('--content-type application/json'))).toBe(true);
    });
  });

  describe('a dry run', () => {
    it.each([
      ['with nothing set', {}],
      ['when asked for', { DRY_RUN: 'true' }],
      ['from anything but an exact "false"', { DRY_RUN: 'False' }],
      ['with an empty value', { DRY_RUN: '' }],
    ])('writes nothing and never calls az: %s', (_label, env) => {
      const s = sandbox([ENTRY]);
      expect(s.run(env, DENYLIST_SCRIPT)).toBe(0);
      expect(s.writes()).toEqual([]);
      expect(s.calls().filter((c) => !c.startsWith('curl '))).toEqual([]);
      for (const blob of ALL_BLOBS) expect(s.blob(blob)).toBe(manifestBytes(blob));
      expect(s.lastOutput).toContain('4 manifest(s) would change. Nothing was written.');
    });

    it('reads the public manifests and shows the change', () => {
      const s = sandbox([ENTRY]);
      expect(s.run({}, DENYLIST_SCRIPT)).toBe(0);
      expect(s.calls().map((c) => c.split(' ').at(-3))).toEqual(ALL_BLOBS.map((b) => `https://stclubhousereleases.blob.core.windows.net/releases/${b}`));
      expect(s.lastOutput).toContain('updates/v2/preview.json: status=updated');
      expect(s.lastOutput).toContain('+    "reason": "hangs on start"');
    });

    it('works from a branch, for previewing a PR', () => {
      const s = sandbox([ENTRY]);
      expect(s.run({ GITHUB_REF: 'refs/heads/some-branch' }, DENYLIST_SCRIPT)).toBe(0);
    });

    it('still fails on a bad entry', () => {
      const s = sandbox([{ ...ENTRY, reason: '' }]);
      expect(s.run({}, DENYLIST_SCRIPT)).not.toBe(0);
      expect(s.calls()).toEqual([]);
    });

    it('still refuses an unmarked empty list', () => {
      const s = sandbox([]);
      expect(s.run({}, DENYLIST_SCRIPT)).not.toBe(0);
    });
  });

  describe('release.yml\'s Generate update manifest step', () => {
    const stepStart = WORKFLOW_TEXT.indexOf('- name: Generate update manifest');
    const stepEnd = WORKFLOW_TEXT.indexOf('- name: Authenticate to Azure', stepStart);
    const runBlock = WORKFLOW_TEXT.slice(stepStart, stepEnd).split(/\r?\n/);
    const block = runBlock.slice(runBlock.findIndex((l) => l.trim() === 'run: |') + 1).map((l) => l.replace(/^ {10}/, '')).join('\n');

    /** A repo standing in for GitHub, with main's list as its only file. */
    function setOrigin(s: Sandbox, list: unknown) {
      const origin = path.join(s.dir, 'origin');
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: origin, encoding: 'utf8' });
      if (!fs.existsSync(origin)) {
        fs.mkdirSync(path.join(origin, 'release'), { recursive: true });
        git('init', '-q', '-b', 'main');
      }
      fs.writeFileSync(path.join(origin, 'release/chat-cli-denylist.json'), `${JSON.stringify(list)}\n`);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', 'list');
    }

    /** Runs the real step, as the publish job would, in a checkout of the tag. */
    function generate(s: Sandbox) {
      if (!fs.existsSync(path.join(s.work, '.git'))) {
        fs.mkdirSync(path.join(s.work, 'scripts/ci'), { recursive: true });
        for (const f of ['cli-denylist.mjs', 'release-notes.mjs']) fs.copyFileSync(path.join(__dirname, f), path.join(s.work, 'scripts/ci', f));
        execFileSync('git', ['init', '-q'], { cwd: s.work });
        execFileSync('git', ['remote', 'add', 'origin', path.join(s.dir, 'origin')], { cwd: s.work });
      }
      const script = block.replace(/\$\{\{ needs\.[\w-]+\.outputs\.(\w+) \}\}/g, (_m, name: string) => {
        if (name === 'version') return s.version;
        if (name === 'is_preview') return String(s.preview);
        return name.startsWith('size_') ? '1' : 'abc';
      });
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: s.work,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: s.dir, RUNNER_TEMP: s.dir, RELEASE_MESSAGE: 'Message', RELEASE_NOTES: 'Notes' },
      });
      s.lastOutput = `${result.stdout}${result.stderr}`;
      return result.status;
    }

    const generated = (s: Sandbox) => JSON.parse(readFileSync(path.join(s.work, 'artifacts', s.preview ? 'preview.json' : 'latest.json'), 'utf8'));

    it.each([['stable', STABLE, false], ['preview', BETA, true]] as const)('includes the list in a %s manifest', (_label, version, preview) => {
      const s = sandbox(null, version, preview);
      setOrigin(s, [ENTRY]);
      expect(generate(s), s.lastOutput).toBe(0);
      const manifest = generated(s);
      expect(manifest.chatCliDenylist).toEqual([ENTRY]);
      expect(manifest.version).toBe(version);
      expect(manifest.artifacts['darwin-arm64'].size).toBe(1);
    });

    it('leaves the field out while the list is null, so a release clears nothing', () => {
      const s = sandbox(null);
      setOrigin(s, null);
      expect(generate(s), s.lastOutput).toBe(0);
      expect(generated(s)).not.toHaveProperty('chatCliDenylist');
    });

    it('writes [] once the file says so', () => {
      const s = sandbox(null);
      setOrigin(s, []);
      expect(generate(s), s.lastOutput).toBe(0);
      expect(generated(s).chatCliDenylist).toEqual([]);
    });

    it('reads main, not the tag, so a list merged after the bump commit survives', () => {
      const s = sandbox([ENTRY]);
      setOrigin(s, [ENTRY, LATER]);
      expect(generate(s), s.lastOutput).toBe(0);
      expect(generated(s).chatCliDenylist).toEqual([ENTRY, LATER]);
    });

    it('fails on a bad list rather than ship it', () => {
      const s = sandbox(null);
      setOrigin(s, [{ ...ENTRY, reason: '' }]);
      expect(generate(s)).not.toBe(0);
      expect(s.lastOutput).toContain('entry 0 needs a reason');
    });

    it.each([
      ['driver', { driver: 'future_driver', versions: ['1.0.0'], reason: 'hangs' }],
      ['provider', { provider: 'future-cli', versions: ['1.0.0'], reason: 'hangs' }],
    ])('a re-run of an older tag fails before any write when main names a %s the tag doesn\'t know', (_label, entry) => {
      const s = sandbox(null);
      setOrigin(s, [entry]);
      expect(generate(s)).not.toBe(0);
      expect(s.lastOutput).toContain('names an unknown');
      expect(s.writes()).toEqual([]);
      expect(s.calls().filter((c) => c.startsWith('az ') || c.startsWith('gh '))).toEqual([]);
      for (const blob of ALL_BLOBS) expect(s.blob(blob)).toBe(manifestBytes(blob));
    });

    it('fails when main can\'t be read rather than publish without the list', () => {
      const s = sandbox(null);
      expect(generate(s)).not.toBe(0);
    });

    it.each([['stable', STABLE, false], ['preview', BETA, true]] as const)('a %s release after a publish still has the entry', (_label, version, preview) => {
      const s = sandbox([ENTRY], version, preview);
      setOrigin(s, [ENTRY]);
      expect(publish(s)).toBe(0);

      expect(generate(s), s.lastOutput).toBe(0);
      expect(s.run()).toBe(0);
      const blob = preview ? 'updates/v2/preview.json' : 'updates/v2/latest.json';
      expect(s.liveVersion(blob)).toBe(version);
      expect(liveList(s, blob)).toEqual([ENTRY]);
      expect(liveList(s, preview ? 'updates/preview.json' : 'updates/latest.json')).toEqual([ENTRY]);
      // The other channel isn't part of this release, and keeps what was published.
      expect(liveList(s, preview ? 'updates/v2/latest.json' : 'updates/v2/preview.json')).toEqual([ENTRY]);
    });

    it('a publish after a release changes only the list in the manifest that release wrote', () => {
      const s = sandbox([ENTRY]);
      setOrigin(s, [ENTRY]);
      expect(generate(s), s.lastOutput).toBe(0);
      expect(s.run()).toBe(0);
      const released = s.blob('updates/v2/latest.json') ?? '';

      writeList(s, [ENTRY, LATER]);
      expect(publish(s)).toBe(0);
      const after = s.blob('updates/v2/latest.json') ?? '';
      expect(JSON.parse(after).chatCliDenylist).toEqual([ENTRY, LATER]);
      expect(after).toBe(released.replace(JSON.stringify([ENTRY]), JSON.stringify([ENTRY, LATER])));
    });
  });
});

describe('publish-cli-denylist.yml wiring', () => {
  const publishJob = DENYLIST_WORKFLOW_TEXT.slice(DENYLIST_WORKFLOW_TEXT.indexOf('\n  publish:'));
  const previewJob = DENYLIST_WORKFLOW_TEXT.slice(DENYLIST_WORKFLOW_TEXT.indexOf('\n  preview:'), DENYLIST_WORKFLOW_TEXT.indexOf('\n  publish:'));

  it('only ever starts by hand', () => {
    const on = DENYLIST_WORKFLOW_TEXT.slice(DENYLIST_WORKFLOW_TEXT.indexOf('\non:'), DENYLIST_WORKFLOW_TEXT.indexOf('\nconcurrency:'));
    expect(on.split(/\r?\n/).filter((l) => /^ {2}\S/.test(l))).toEqual(['  workflow_dispatch:']);
  });

  it('is dry by default, and clearing is off by default', () => {
    expect(DENYLIST_WORKFLOW_TEXT).toMatch(/dry_run:[\s\S]*?default: true/);
    expect(DENYLIST_WORKFLOW_TEXT).toMatch(/clear_list:[\s\S]*?default: false/);
  });

  it('has no input that could carry a list', () => {
    const inputs = DENYLIST_WORKFLOW_TEXT.slice(DENYLIST_WORKFLOW_TEXT.indexOf('inputs:'), DENYLIST_WORKFLOW_TEXT.indexOf('\nconcurrency:'));
    expect(inputs.split(/\r?\n/).filter((l) => /^ {6}\S/.test(l))).toEqual(['      clear_list:', '      dry_run:']);
  });

  it('gives the preview job no way to write', () => {
    expect(previewJob).not.toMatch(/azure\/login|id-token|environment:|secrets\./);
    expect(previewJob).toContain("DRY_RUN: 'true'");
  });

  it('publishes only when not dry, from main, with the release environment\'s credentials', () => {
    expect(publishJob).toContain('if: ${{ !inputs.dry_run }}');
    expect(publishJob).toContain('environment: release');
    expect(publishJob).toMatch(/actions\/checkout@\S+\r?\n\s+with:\r?\n\s+ref: main/);
    expect(publishJob.indexOf('azure/login')).toBeLessThan(publishJob.indexOf('run: bash scripts/ci/publish-cli-denylist.sh'));
  });

  it('never queues behind itself out of order or cancels a run part way', () => {
    expect(DENYLIST_WORKFLOW_TEXT).toContain('cancel-in-progress: false');
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
