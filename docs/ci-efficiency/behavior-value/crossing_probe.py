"""Challenge the zero-marginal marks result using two serial runs of the original 55 tests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from probe_tree import source_tree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASE = 'f5c566f89e093f4cb9322cc59b37de7ee2798331'
CHAT = 'src/renderer/features/agents/chat/'
# Accept the first proposed Markdown rendering without verifying the round trip.
ANCHOR = 'const parsed = parseInline(candidate.value).nodes.flatMap'


def main():
    modules = Path(os.environ.get('CODEC_NODE_MODULES', str(ROOT / 'node_modules'))).resolve()
    rows = []
    with source_tree(ROOT, BASE, modules) as tree:
        codec = tree / CHAT / 'prompt-codec.ts'
        original = codec.read_text()
        if original.count(ANCHOR) != 1:
            raise ValueError('Mutation anchor changed')
        # Replace the complete verification block, keeping the variant valid TypeScript.
        begin = original.index('        ' + ANCHOR)
        end = original.index('\n      }\n', begin)
        variant = original[:begin] + '        output = candidate;\n        break;' + original[end:]
        for name, text in [('original', original), ('first_render', variant)]:
            codec.write_text(text)
            out = tree / (name + '.json')
            start = time.monotonic()
            proc = subprocess.run([str(modules / '.bin/vitest'), 'run', '--project', 'renderer',
                '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile', str(out),
                CHAT + 'prompt-codec.test.ts'], cwd=tree,
                env={**os.environ, 'NODE_OPTIONS': '--no-experimental-webstorage --max-old-space-size=768'},
                capture_output=True, timeout=25)
            report = json.loads(out.read_text())
            suites = report['testResults']
            if len(suites) != 1 or report.get('numRuntimeErrorTestSuites') or report.get('unhandledErrors'):
                raise ValueError('Invalid suite')
            tests = suites[0]['assertionResults']
            failures = [t for t in tests if t['status'] == 'failed']
            if (len(tests) != 55 or report['numPassedTests'] + len(failures) != 55 or
                    len(failures) != report['numFailedTests'] or proc.returncode != int(bool(failures))
                    or bool(failures) != (name == 'first_render')):
                raise ValueError('Unexpected outcome')
            observations = []
            for t in tests:
                messages = t['failureMessages']
                if t['status'] == 'failed' and (len(messages) != 1 or not messages[0].startswith('AssertionError:')):
                    raise ValueError(('Non-assertion failure', t['title']))
                observations.append({'identity': t['fullName'], 'ms': t['duration'], 'status': t['status'],
                                     'reason': messages[0].split('\n    at ')[0].split('\n\n')[0] if messages else None})
            rows.append({'variant': name, 'wall_seconds': round(time.monotonic() - start, 4),
                         'sha256': hashlib.sha256(text.encode()).hexdigest(), 'tests': observations})
    (HERE / 'crossing-receipt.json').write_text(json.dumps({'base': BASE, 'rows': rows}, indent=2) + '\n')


if __name__ == '__main__':
    main()
