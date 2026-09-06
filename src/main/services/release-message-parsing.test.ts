import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Tests for the release message extraction logic used in .github/workflows/release.yml.
 *
 * The workflow parses the first line of the version-bump PR body for a
 * "Release: <title>" prefix, using the title as the update banner tagline and
 * the remainder as release notes. These TypeScript functions replicate the
 * shell pipeline so we can validate the parsing without platform-specific sed.
 */

/** Extracts the release message from the first line if it starts with "Release: ". */
function extractReleaseMessage(prBody: string): string {
  const firstLine = prBody.split('\n')[0] || '';
  if (firstLine.startsWith('Release: ')) {
    return firstLine.slice('Release: '.length);
  }
  return '';
}

/** Extracts release notes by stripping the Release: line, test plan, and metadata. */
function extractReleaseNotes(prBody: string): string {
  let lines = prBody.split('\n');

  // Strip "Release: ..." first line (mirrors: sed '1{/^Release: /d}')
  if (lines[0]?.startsWith('Release: ')) {
    lines = lines.slice(1);
  }

  // Trim leading blank lines (mirrors: sed '/./,$!d')
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  // Remove everything from "## Test Plan" onward (mirrors: sed '/^## Test [Pp]lan/,$d')
  const testPlanIdx = lines.findIndex((l) => /^## Test [Pp]lan/.test(l));
  if (testPlanIdx !== -1) {
    lines = lines.slice(0, testPlanIdx);
  }

  // Strip Co-Authored-By lines
  lines = lines.filter((l) => !/Co-[Aa]uthored-[Bb]y:/.test(l));

  // Strip "Generated with [Claude Code]" lines
  lines = lines.filter((l) => !/Generated with \[Claude Code\]/.test(l));

  // Strip emoji-prefixed bot lines
  lines = lines.filter((l) => !l.startsWith('🤖'));

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function extractRunScripts(workflow: string): string[] {
  const lines = workflow.split('\n');
  const scripts: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const runMatch = lines[index].match(/^(\s*)run: \|$/);
    if (!runMatch) {
      continue;
    }

    const runIndent = runMatch[1].length;
    const scriptLines: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() !== '' && line.search(/\S/) <= runIndent) {
        index -= 1;
        break;
      }
      scriptLines.push(line.slice(runIndent + 2));
    }
    scripts.push(scriptLines.join('\n'));
  }

  return scripts;
}

describe('release message parsing (workflow shell pipeline)', () => {
  it('passes release text through environment bindings instead of run expressions', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../../.github/workflows/release.yml'),
      'utf8',
    );
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    const runScripts = extractRunScripts(workflow).join('\n');

    expect(runScripts).not.toMatch(
      /\$\{\{\s*needs\.verify-tag\.outputs\.(release_message|release_notes)\s*\}\}/,
    );
    expect(publishJob).toContain(
      'RELEASE_MESSAGE: ${{ needs.verify-tag.outputs.release_message }}',
    );
    expect(publishJob).toContain(
      'RELEASE_NOTES: ${{ needs.verify-tag.outputs.release_notes }}',
    );
    expect(publishJob).toContain('MESSAGE="$RELEASE_MESSAGE"');
    expect(publishJob).toContain('NOTES="$RELEASE_NOTES"');
    expect(publishJob).toContain('RELEASE_TITLE="v${VERSION} — ${RELEASE_MESSAGE}"');
    expect(publishJob).toContain('RELEASE_BODY="$RELEASE_NOTES"');
  });

  it('passes shell-special release text literally through title and body construction', () => {
    const releaseText = [
      'A "quoted" `release` with $(printf hacked)',
      'MESSAGE_EOF',
      'and a final line',
    ].join('\n');
    const shellScript = [
      'set -eu',
      'MESSAGE="$RELEASE_MESSAGE"',
      'NOTES="$RELEASE_NOTES"',
      'RELEASE_TITLE="v0.41.0 — ${RELEASE_MESSAGE}"',
      'RELEASE_BODY="$RELEASE_NOTES"',
      'printf "%s\\0%s\\0%s\\0" "$RELEASE_TITLE" "$RELEASE_BODY" "$MESSAGE"',
    ].join('\n');
    const output = execFileSync('bash', ['-c', shellScript], {
      env: {
        ...process.env,
        RELEASE_MESSAGE: releaseText,
        RELEASE_NOTES: releaseText,
      },
      encoding: 'utf8',
    });
    const [title, body, message] = output.split('\0');

    expect(title).toBe(`v0.41.0 — ${releaseText}`);
    expect(body).toBe(releaseText);
    expect(message).toBe(releaseText);
  });

  describe('extractReleaseMessage', () => {
    it('extracts title from "Release: ..." first line', () => {
      const body = 'Release: Plugin Improvements & More\n\n# New Features\n- Added widget';
      expect(extractReleaseMessage(body)).toBe('Plugin Improvements & More');
    });

    it('returns empty when PR body has no Release: prefix', () => {
      const body = '# New Features\n- Added widget\n\n# Bug Fixes\n- Fixed crash';
      expect(extractReleaseMessage(body)).toBe('');
    });

    it('returns empty for empty body', () => {
      expect(extractReleaseMessage('')).toBe('');
    });

    it('handles title with special characters', () => {
      const body = 'Release: Bug Fixes & Performance — v2\n\n# Bug Fixes\n- Fixed crash';
      expect(extractReleaseMessage(body)).toBe('Bug Fixes & Performance — v2');
    });

    it('does not match "Release:" on non-first lines', () => {
      const body = '# Notes\nRelease: Not a title\n- Stuff';
      expect(extractReleaseMessage(body)).toBe('');
    });
  });

  describe('extractReleaseNotes', () => {
    it('strips Release: line and returns remaining content', () => {
      const body = 'Release: Some Title\n\n# New Features\n- Added widget';
      const notes = extractReleaseNotes(body);
      expect(notes).not.toContain('Release:');
      expect(notes).toContain('# New Features');
      expect(notes).toContain('- Added widget');
    });

    it('preserves body as-is when no Release: line', () => {
      const body = '# New Features\n- Added widget\n\n# Bug Fixes\n- Fixed crash';
      const notes = extractReleaseNotes(body);
      expect(notes).toContain('# New Features');
      expect(notes).toContain('# Bug Fixes');
    });

    it('strips test plan section', () => {
      const body = 'Release: Title\n\n# New Features\n- Widget\n\n## Test Plan\n- Run tests\n- Check UI';
      const notes = extractReleaseNotes(body);
      expect(notes).toContain('- Widget');
      expect(notes).not.toContain('Test Plan');
      expect(notes).not.toContain('Run tests');
    });

    it('strips Co-Authored-By lines', () => {
      const body = 'Release: Title\n\n# Bug Fixes\n- Fix\nCo-Authored-By: Bot <bot@test.com>';
      const notes = extractReleaseNotes(body);
      expect(notes).toContain('- Fix');
      expect(notes).not.toContain('Co-Authored-By');
    });

    it('strips Claude Code generated line', () => {
      const body = 'Release: Title\n\n# Bug Fixes\n- Fix\nGenerated with [Claude Code](https://claude.com)';
      const notes = extractReleaseNotes(body);
      expect(notes).toContain('- Fix');
      expect(notes).not.toContain('Generated with');
    });

    it('strips emoji bot lines', () => {
      const body = 'Release: Title\n\n# Bug Fixes\n- Fix\n🤖 Auto-generated';
      const notes = extractReleaseNotes(body);
      expect(notes).toContain('- Fix');
      expect(notes).not.toContain('🤖');
    });

    it('trims leading blank lines after stripping Release: line', () => {
      const body = 'Release: Title\n\n# New Features\n- Widget';
      const notes = extractReleaseNotes(body);
      expect(notes).toMatch(/^#/);
    });

    it('trims trailing blank lines', () => {
      const body = 'Release: Title\n\n# Bug Fixes\n- Fix\n\n\n';
      const notes = extractReleaseNotes(body);
      expect(notes).toBe('# Bug Fixes\n- Fix');
    });

    it('handles full realistic PR body', () => {
      const body = [
        'Release: Plugin System & Agent Improvements',
        '',
        '# New Features',
        '- Added plugin permission system with configurable allow/deny rules',
        '- Added model selector to agent settings',
        '',
        '# Bug Fixes',
        '- Fixed plugin popups clipping under side panels',
        '',
        '# Improvements',
        '- Improved agent restart reliability',
        '',
        '## Test Plan',
        '- Verify plugin permissions work',
        '- Check agent settings UI',
        '',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
      ].join('\n');

      const message = extractReleaseMessage(body);
      expect(message).toBe('Plugin System & Agent Improvements');

      const notes = extractReleaseNotes(body);
      expect(notes).toContain('# New Features');
      expect(notes).toContain('plugin permission system');
      expect(notes).toContain('# Bug Fixes');
      expect(notes).toContain('# Improvements');
      expect(notes).not.toContain('Release:');
      expect(notes).not.toContain('Test Plan');
      expect(notes).not.toContain('Co-Authored-By');
      expect(notes).not.toContain('Generated with');
      expect(notes).not.toContain('🤖');
      expect(notes).toMatch(/^#/); // starts with heading, no leading blanks
    });
  });
});
