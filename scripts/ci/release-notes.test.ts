import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extract,
  isPreviewTag,
  main,
  parsePrBody,
  rewriteManifest,
  validateNotes,
  valueSpans,
  versionForTag,
} from './release-notes.mjs';

const NOTES = '# New Features\n- Added a thing\n\n# Bug Fixes\n- Fixed a thing';
const BUMP_BODY = `Release: Big Release\n\n${NOTES}\n`;

/** A scratch repo whose commits are squash merges onto main, like the real one. */
class Repo {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  shas: Record<string, string> = {};
  pkg: { version?: string; dependencies?: Record<string, string> } = {};

  git = (args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args,
  ], { cwd: this.dir, encoding: 'utf8' });

  constructor() {
    this.git(['init', '-q', '-b', 'main']);
  }

  commit(subject: string, version?: string, deps?: string) {
    if (version) this.pkg.version = version;
    if (deps) this.pkg.dependencies = { dep: deps };
    fs.writeFileSync(path.join(this.dir, 'package.json'), JSON.stringify(this.pkg, null, 2));
    fs.writeFileSync(path.join(this.dir, 'log.txt'), `${subject}\n`, { flag: 'a' });
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', subject]);
    const sha = this.git(['rev-parse', 'HEAD']).trim();
    const pr = /\(#(\d+)\)$/.exec(subject);
    if (pr) this.shas[pr[1]] = sha;
    return sha;
  }

  tag(name: string, message = 'Big Release (Beta)', rev = 'HEAD') {
    this.git(['tag', '-a', name, '-m', message, rev]);
  }

  cleanup() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A fake GitHub API: every PR whose number appears in a commit subject. */
function fakeGithub(repo: Repo, bodies: Record<number, string>, { linked = true } = {}) {
  return {
    pullsForCommit: (sha: string) => (linked
      ? Object.entries(repo.shas).filter(([, s]) => s === sha)
        .map(([n]) => ({ number: Number(n), merge_commit_sha: sha, merged_at: '2026-10-30T00:00:00Z' }))
      : []),
    pullBody: (n: number) => bodies[n] ?? 'Ordinary PR body',
  };
}

describe('release-notes', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = new Repo();
    repo.commit('Initial (#1)', '1.0.0');
    repo.commit('Some feature (#2)');
    repo.commit('chore: bump version to 1.1.0-beta.1 (Preview) (#3)', '1.1.0-beta.1');
  });
  afterEach(() => repo.cleanup());

  describe('extract', () => {
    it('takes the notes and message from the bump PR when the tag is on it', () => {
      repo.tag('v1.1.0-beta.1');
      const result = extract({ git: repo.git, github: fakeGithub(repo, { 3: BUMP_BODY }), tag: 'v1.1.0-beta.1' });
      expect(result).toMatchObject({
        version: '1.1.0-beta.1',
        bumpSha: repo.shas[3],
        bumpPr: 3,
        pastBump: [],
        message: 'Big Release',
        notes: NOTES,
      });
    });

    it('fails when the tag is past the bump commit, listing the PRs in between', () => {
      repo.commit('Annex terminals (#4)', undefined, '2.0.0');
      repo.commit('Rich chat files (#5)');
      repo.tag('v1.1.0-beta.1');
      const run = () => extract({ git: repo.git, github: fakeGithub(repo, { 3: BUMP_BODY, 5: '## Summary\nAgent PR' }), tag: 'v1.1.0-beta.1' });
      expect(run).toThrow(/2 commit\(s\) after the version bump/);
      expect(run).toThrow(/Annex terminals \(#4\)\n.*Rich chat files \(#5\)/);
      expect(run).toThrow(new RegExp(`git tag -s v1\\.1\\.0-beta\\.1 -m "<release message>" ${repo.shas[3]}`));
    });

    it('a dependency change to package.json after the bump is not a bump', () => {
      repo.commit('Update dep (#4)', undefined, '3.0.0');
      repo.tag('v1.1.0-beta.1');
      expect(() => extract({ git: repo.git, github: fakeGithub(repo, { 3: BUMP_BODY }), tag: 'v1.1.0-beta.1' }))
        .toThrow(/Update dep \(#4\)/);
    });

    it('the override still takes the bump PR notes and warns about the extra PRs', () => {
      repo.commit('Annex terminals (#4)');
      repo.tag('v1.1.0-beta.1');
      const result = extract({ git: repo.git, github: fakeGithub(repo, { 3: BUMP_BODY }), tag: 'v1.1.0-beta.1', allowPastBump: true });
      expect(result.bumpPr).toBe(3);
      expect(result.notes).toBe(NOTES);
      expect(result.pastBump.map((c: { subject: string }) => c.subject)).toEqual(['Annex terminals (#4)']);
      expect(result.warnings[0]).toMatch(/Annex terminals \(#4\)/);
    });

    it('fails when package.json at the tag has a different version', () => {
      repo.tag('v1.2.0-beta.1');
      expect(() => extract({ git: repo.git, github: fakeGithub(repo, {}), tag: 'v1.2.0-beta.1' }))
        .toThrow(/package.json at v1\.2\.0-beta\.1 .* is 1\.1\.0-beta\.1, not 1\.2\.0-beta\.1/);
    });

    it('falls back to the PR number in the subject when GitHub links no PR', () => {
      repo.tag('v1.1.0-beta.1');
      const result = extract({ git: repo.git, github: fakeGithub(repo, { 3: BUMP_BODY }, { linked: false }), tag: 'v1.1.0-beta.1' });
      expect(result.bumpPr).toBe(3);
    });

    it('prefers the squash subject over a PR that merely contains the commit', () => {
      repo.tag('v1.1.0-beta.1');
      const github = {
        pullsForCommit: () => [{ number: 99, merge_commit_sha: 'other', merged_at: 'x' }],
        pullBody: (n: number) => (n === 3 ? BUMP_BODY : '## Summary'),
      };
      expect(extract({ git: repo.git, github, tag: 'v1.1.0-beta.1' }).bumpPr).toBe(3);
    });

    it('fails when no PR can be found for the bump commit', () => {
      repo.commit('chore: bump version to 1.1.0', '1.1.0');
      repo.tag('v1.1.0', 'Big Release');
      expect(() => extract({ git: repo.git, github: fakeGithub(repo, {}, { linked: false }), tag: 'v1.1.0' }))
        .toThrow(/No PR found for the bump commit/);
    });

    it('fails on empty notes rather than publishing the tag subject', () => {
      repo.tag('v1.1.0-beta.1');
      expect(() => extract({ git: repo.git, github: fakeGithub(repo, { 3: 'Release: Big Release\n\n' }), tag: 'v1.1.0-beta.1' }))
        .toThrow(/the notes are empty/);
    });

    it('fails when the bump PR body reads like a PR description', () => {
      repo.tag('v1.1.0-beta.1');
      const body = `Release: Big Release\n\n${NOTES}\n\n## Validation\n- npm run typecheck\n\nFixes #2508`;
      const run = () => extract({ git: repo.git, github: fakeGithub(repo, { 3: body }), tag: 'v1.1.0-beta.1' });
      expect(run).toThrow(/bump PR #3 can't be published/);
      expect(run).toThrow(/issue-closing keyword/);
      expect(run).toThrow(/PR section heading/);
      expect(run).toThrow(/npm command/);
    });

    it('uses the tag subject as the message when the body has no Release line', () => {
      repo.tag('v1.1.0-beta.1', 'Tag Subject (Beta)');
      const result = extract({ git: repo.git, github: fakeGithub(repo, { 3: NOTES }), tag: 'v1.1.0-beta.1' });
      expect(result.message).toBe('Tag Subject (Beta)');
    });

    it('finds the bump when the version was set by the root commit', () => {
      const fresh = new Repo();
      try {
        fresh.commit('chore: bump version to 0.1.0 (#9)', '0.1.0');
        fresh.tag('v0.1.0', 'First');
        expect(extract({ git: fresh.git, github: fakeGithub(fresh, { 9: NOTES }), tag: 'v0.1.0' }).bumpPr).toBe(9);
      } finally {
        fresh.cleanup();
      }
    });
  });

  describe('parsePrBody', () => {
    it('drops the Release line, test plan and generated trailers, and normalises CRLF', () => {
      const body = ['Release: Title', '', '# Bug Fixes', '- Fixed', '', '## Test plan', '- ran it', '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\r\n');
      expect(parsePrBody(body)).toEqual({ message: 'Title', notes: '# Bug Fixes\n- Fixed' });
    });

    it('drops trailers outside a test plan and trailing blank lines', () => {
      const body = 'Release: T\n\n# Improvements\n- Faster\nCo-Authored-By: X <x@y>\n\n\n';
      expect(parsePrBody(body)).toEqual({ message: 'T', notes: '# Improvements\n- Faster' });
    });

    it('handles a missing body', () => {
      expect(parsePrBody(null)).toEqual({ message: null, notes: '' });
    });
  });

  describe('validateNotes', () => {
    it('accepts notes in the bump PR format', () => {
      expect(validateNotes(NOTES)).toEqual([]);
      expect(validateNotes('# Improvements\n- Upgraded Electron. Fixes a crash on #2 monitors')).toEqual([]);
      expect(validateNotes('# New Features\n- Thumbnails generated with the new renderer')).toEqual([]);
    });

    it('rejects notes that do not open with a known heading', () => {
      expect(validateNotes('## Summary\nStuff')[0]).toMatch(/must start with "# New Features"/);
      expect(validateNotes('Release: oops\n# Bug Fixes')[0]).toMatch(/must start with/);
    });

    it.each([
      ['Fixes #2508', /issue-closing/],
      ['Closes #1', /issue-closing/],
      ['## Validation\n- ok', /PR section heading/],
      ['## Summary', /PR section heading/],
      ['🤖 Generated with [Codex](https://x)', /Generated with/],
      ['- ran `npm test`', /npm command/],
      ['- [x] typecheck', /checklist/],
    ])('rejects the PR-body marker %j', (marker, problem) => {
      const problems = validateNotes(`${NOTES}\n${marker}`);
      expect(problems.some((p: string) => problem.test(p))).toBe(true);
    });
  });

  describe('versionForTag / isPreviewTag', () => {
    it('maps tags to package versions and channels', () => {
      expect(versionForTag('v0.42.0-beta.10')).toBe('0.42.0-beta.10');
      expect(versionForTag('v1.0.0rc')).toBe('1.0.0');
      expect(isPreviewTag('v0.42.0-beta.10')).toBe(true);
      expect(isPreviewTag('v1.0.0rc')).toBe(true);
      expect(isPreviewTag('v0.41.0')).toBe(false);
    });
  });

  describe('rewriteManifest', () => {
    // Formatted by hand, not by jq, with \u escapes: the rewrite must not reformat it.
    const manifest = '{\n    "version": "1.1.0-beta.1",\n    "releaseDate": "2026-10-30T07:25:05Z",\n'
      + '    "releaseMessage": "Old \\u2192 message",\n    "releaseNotes": "# Bug Fixes\\n- old",\n'
      + '    "artifacts": {"darwin-arm64": {"url": "https://x/y.zip", "sha256": "abc", "size": 12}}\n}';

    it('swaps only the notes, keeping every other byte', () => {
      const out = rewriteManifest(manifest, { version: '1.1.0-beta.1', notes: '# Bug Fixes\n- new → fixed' });
      expect(out.status).toBe('updated');
      expect(out.text).toBe(manifest.replace('"# Bug Fixes\\n- old"', '"# Bug Fixes\\n- new \\u2192 fixed"'));
    });

    it('keeps raw UTF-8 when the file used raw UTF-8', () => {
      const raw = '{"version":"1","releaseMessage":"m","releaseNotes":"a → b"}';
      expect(rewriteManifest(raw, { version: '1', notes: 'c → d' }).text).toBe('{"version":"1","releaseMessage":"m","releaseNotes":"c → d"}');
    });

    it('updates the message only when one is given', () => {
      const out = rewriteManifest(manifest, { version: '1.1.0-beta.1', notes: '# Bug Fixes\n- old', message: 'New' });
      expect(out.text).toBe(manifest.replace('"Old \\u2192 message"', '"New"'));
    });

    it('is unchanged when the notes already match', () => {
      expect(rewriteManifest(manifest, { version: '1.1.0-beta.1', notes: '# Bug Fixes\n- old' }))
        .toEqual({ status: 'unchanged', text: manifest });
    });

    it('skips a manifest that has moved on to another version', () => {
      expect(rewriteManifest(manifest, { version: '1.0.0', notes: NOTES }))
        .toMatchObject({ status: 'skipped', text: manifest, reason: expect.stringMatching(/1\.1\.0-beta\.1, not 1\.0\.0/) });
    });

    it('edits only that version\'s history entry', () => {
      const history = JSON.stringify([
        { version: '1.1.0', releaseDate: 'd2', releaseMessage: 'm2', releaseNotes: 'n2' },
        { version: '1.0.0', releaseDate: 'd1', releaseMessage: 'm1', releaseNotes: 'n1' },
      ], null, 2) + '\n';
      const out = rewriteManifest(history, { version: '1.0.0', notes: NOTES, history: true });
      expect(out.status).toBe('updated');
      expect(out.text).toBe(history.replace('"n1"', JSON.stringify(NOTES)));
      expect(rewriteManifest(history, { version: '9.9.9', notes: NOTES, history: true }).status).toBe('skipped');
    });

    it('does not touch a nested releaseNotes key', () => {
      const tricky = '{"version":"1","artifacts":{"releaseNotes":"keep"},"releaseNotes":"old"}';
      expect(rewriteManifest(tricky, { version: '1', notes: 'new' }).text)
        .toBe('{"version":"1","artifacts":{"releaseNotes":"keep"},"releaseNotes":"new"}');
    });

    it('refuses malformed JSON', () => {
      expect(() => valueSpans('{"a": 1,}')).toThrow();
    });
  });

  describe('CLI', () => {
    it('writes outputs under a delimiter a hostile PR body cannot close', () => {
      repo.tag('v1.1.0-beta.1');
      const body = `Release: Big Release\n\n# Bug Fixes\n- a\nRELEASE_NOTES_EOF\nis_preview=false\nEOF\n$(touch pwned)`;
      let text = '';
      main(['extract', '--tag', 'v1.1.0-beta.1', '--github-output'], {
        git: repo.git,
        github: fakeGithub(repo, { 3: body }),
        appendOutput: (entry: string) => { text += entry; },
      });
      const m = /^release_notes<<(EOF_[0-9a-f]{32})\n([\s\S]*?)\n\1\n/m.exec(text);
      expect(m?.[2]).toBe('# Bug Fixes\n- a\nRELEASE_NOTES_EOF\nis_preview=false\nEOF\n$(touch pwned)');
      expect(fs.existsSync(path.join(repo.dir, 'pwned'))).toBe(false);
    });
  });
});
