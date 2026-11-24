"""Compare a real editor range replacement and the codec endpoint control.

Run from the repository root with the same local module directory as the matrix.
The probe uses the already sampled cached-position fault and never mutates a checkout.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from probe_tree import source_tree
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
HEAD = '18a907edd89f833a5956e0794c0d20ded1207d20'
CHAT = 'src/renderer/features/agents/chat/'
EDITOR = 'replaces a source range while preserving adjacent text and emphasis'
CODEC = 'maps slash-token offsets through list and emphasis syntax'
ORIGINAL = 'positions[pos + 1 + i] = base + offset;'
SHIFT = 'positions[pos + 1 + i] = base + offset + 1;'


def main():
    modules = Path(os.environ.get('CODEC_NODE_MODULES', str(ROOT / 'node_modules'))).resolve()
    results = []
    with source_tree(ROOT, HEAD, modules) as tree:
        codec = tree / CHAT / 'prompt-codec.ts'
        original = codec.read_text()
        if original.count(ORIGINAL) != 1:
            raise ValueError('Ambiguous mutation anchor')
        for variant in ['original', 'shift', 'restored']:
            codec.write_text(original.replace(ORIGINAL, SHIFT) if variant == 'shift' else original)
            out = tree / (variant + '.json')
            start = time.monotonic()
            proc = subprocess.run([str(modules / '.bin/vitest'), 'run', '--project', 'renderer',
                '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile', str(out),
                '-t', EDITOR + '|' + CODEC, CHAT + 'PromptEditor.test.tsx', CHAT + 'prompt-codec.test.ts'],
                cwd=tree, env={**os.environ, 'NODE_OPTIONS': '--no-experimental-webstorage --max-old-space-size=768'},
                capture_output=True, timeout=30)
            report = json.loads(out.read_text())
            tests = [t for s in report['testResults'] for t in s['assertionResults']
                     if t['status'] not in ['pending', 'skipped']]
            if sorted(t['title'] for t in tests) != sorted([CODEC, EDITOR]):
                raise ValueError('Suite or identity mismatch')
            failures = [t for t in tests if t['status'] == 'failed']
            nfailed = int(variant == 'shift')
            if not (len(failures) == report['numFailedTests'] == proc.returncode == nfailed
                    and report['numPassedTests'] == 2 - nfailed and not report.get('unhandledErrors')
                    and not report.get('numRuntimeErrorTestSuites')):
                raise ValueError(('Unexpected outcome', variant, tests))
            reasons = []
            for test in failures:
                messages = test['failureMessages']
                if not (test['title'] == EDITOR and len(messages) == 1
                        and messages[0].startswith('AssertionError: expected')
                        and '/compact later' in messages[0]):
                    raise ValueError(('Unexpected failure', messages))
                reasons.append(messages[0].split('\n    at ')[0])
            results.append({'variant': variant, 'codec_sha256': hashlib.sha256(codec.read_bytes()).hexdigest(),
                'wall_seconds': round(time.monotonic() - start, 4), 'deselected': report['numPendingTests'],
                'tests': [{'name': t['title'], 'status': t['status'], 'ms': t['duration']} for t in tests],
                'reasons': reasons})
    (HERE / 'editor-receipt.json').write_text(json.dumps({'source': HEAD, 'variants': results}, indent=2) + '\n')


if __name__ == '__main__':
    main()
