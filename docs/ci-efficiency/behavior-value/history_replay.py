"""Replay the real #3594 bug and the fix with the same published test blobs.

Run from the repository root. CODEC_NODE_MODULES may point to a prepared local
dependency directory. Git supplies immutable source. No dependency installation,
network operation, CI invocation, or checkout edit is performed by this script.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from probe_tree import source_tree
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
FIX = 'c44e472952561e565ac78b7114e011e6f9a5e999'
PARENT = 'ad5789182f348521a738d67a3d11f83a21b87a9c'
CHAT = 'src/renderer/features/agents/chat/'
PRODUCTION = ['prompt-codec.ts', 'prompt-editor.ts', 'PromptEditor.tsx']
SUITES = ['prompt-codec.test.ts', 'PromptEditor.test.tsx', 'PromptMarkdown.test.tsx']
FAMILIES = ['restores pasted text exactly:', 'survives a remount and the next keystroke:',
            'survives a failed-send restore and the next keystroke:']
FILTER = '|'.join([*FAMILIES, 'renders repeated numbering', 'renders bold inside',
                   'renders mixed bullet', 'renders a continuation line'])


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_variant(tree, modules, revision, reporter):
    for name in PRODUCTION:
        (tree / CHAT / name).write_bytes(git('show', revision + ':' + CHAT + name))
    env = {**os.environ, 'NODE_OPTIONS': '--no-experimental-webstorage --max-old-space-size=768'}
    cmd = [str(modules / '.bin/vitest'), 'run', '--project', 'renderer', '--maxWorkers=1',
           '--no-file-parallelism', '--reporter=json', '--outputFile', str(reporter),
           '-t', FILTER, *[CHAT + suite for suite in SUITES]]
    start = time.monotonic()
    proc = subprocess.run(cmd, cwd=tree, env=env, capture_output=True, timeout=30)
    elapsed = round(time.monotonic() - start, 4)
    if not reporter.exists():
        sys.stderr.buffer.write(proc.stderr[-4000:])
        raise RuntimeError('Runner produced no JSON')
    report = json.loads(reporter.read_text())
    if report.get('numRuntimeErrorTestSuites') or len(report['testResults']) != 3:
        raise ValueError(('Invalid suite load', [(f.get('name'), f.get('message')) for f in report['testResults']], proc.stderr.decode()[-2000:]))
    observations = []
    for suite in report['testResults']:
        for test in suite['assertionResults']:
            if test['status'] in ('pending', 'skipped'):
                continue
            errors = test['failureMessages']
            family = next((f for f in FAMILIES if f in test['title']), 'sent markdown')
            expected_failure = revision == PARENT and family != 'sent markdown'
            if expected_failure:
                if test['status'] != 'failed' or len(errors) != 1 or 'AssertionError: expected' not in errors[0] or 'to be' not in errors[0]:
                    raise ValueError(('Expected exact-text assertion failure', test['title'], errors[:1]))
            elif test['status'] != 'passed' or errors:
                raise ValueError(('Expected passing control', test['title'], errors[:1]))
            observations.append({'file': Path(suite['name']).name, 'test': test['title'],
                                 'status': test['status'], 'family': family,
                                 'duration_ms': test.get('duration'),
                                 'reason': errors[0].split('\n    at ')[0].split('\n\n')[0] if errors else None})
    actual_sizes = {family: sum(t['family'] == family for t in observations)
                    for family in [*FAMILIES, 'sent markdown']}
    if list(actual_sizes.values()) != [6, 6, 6, 4] or proc.returncode != int(revision == PARENT):
        raise ValueError((actual_sizes, proc.returncode))
    return {'production_revision': revision, 'wall_seconds': elapsed,
            'exit': proc.returncode, 'deselected': report['numPendingTests'],
            'production_sha256': {name: digest(tree / CHAT / name) for name in PRODUCTION},
            'observations': observations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=HERE / 'history-receipt.json')
    args = parser.parse_args()
    modules = Path(os.environ.get('CODEC_NODE_MODULES', str(ROOT / 'node_modules'))).resolve()
    expected = {CHAT + name for name in [*PRODUCTION, *SUITES, 'prompt-editor.testing.ts']}
    if set(git('diff', '--name-only', PARENT, FIX).decode().splitlines()) != expected:
        raise ValueError('Historical diff differs from the audited seven files')
    with source_tree(ROOT, FIX, modules) as tree:
        inputs = [CHAT + n for n in [*SUITES, 'prompt-editor.testing.ts']]
        inputs += ['test/setup-renderer.ts', 'vitest.config.ts', 'package-lock.json']
        receipt = {'historical_parent': PARENT, 'historical_fix': FIX,
                   'node': subprocess.check_output(['node', '-v'], text=True).strip(),
                   'platform': platform.system() + '/' + platform.machine(),
                   'inputs_sha256': {p: digest(tree / p) for p in inputs},
                   'installed_versions': {pkg: json.loads((modules / pkg / 'package.json').read_text())['version']
                       for pkg in ['vitest', 'jsdom', 'marked', 'prosemirror-model', 'prosemirror-view']},
                   'variants': [run_variant(tree, modules, rev, tree / (rev + '.json'))
                                for rev in (PARENT, FIX)]}
    args.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
