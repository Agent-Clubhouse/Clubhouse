#!/usr/bin/env python3
"""Verify or replay sealed #3738 evidence using existing dependencies and a supplied resource gate."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MANIFEST = json.loads((HERE / 'manifest.json').read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_hashes():
    return {name: sha(ROOT / name) for name in MANIFEST['source_sha256']}


def verify():
    for section in ['source_sha256', 'focused_test_sha256']:
        for name, expected in MANIFEST[section].items():
            if sha(ROOT / name) != expected:
                raise RuntimeError(f'Source mismatch: {name}')
    if sha(ROOT / 'package-lock.json') != MANIFEST['package_lock_sha256']:
        raise RuntimeError('Dependency lock mismatch; do not install or substitute dependencies')
    for line in (HERE / 'SHA256SUMS').read_text().splitlines():
        expected, name = line.split('  ', 1)
        if sha(HERE / name) != expected:
            raise RuntimeError(f'Evidence mismatch: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['verify', 'baseline', 'importers-exact', 'typecheck-exact', 'lint-exact', 'mutation-incarnation', 'mutation-display'])
    parser.add_argument('--gate', help='Path to the existing approved resource-admission script')
    parser.add_argument('--owner', default='mcp-stable-binding-name')
    parser.add_argument('--output', type=Path, help='Directory for new raw receipts; required for a run')
    args = parser.parse_args()
    verify()
    if args.mode == 'verify':
        print(f"Verified sealed artifacts and source {MANIFEST['source_head']}")
        return 0
    if not args.gate or not args.output:
        parser.error('--gate and --output are required to run a check')
    if not (ROOT / 'node_modules').exists():
        raise RuntimeError('Matched existing dependencies are required; this script never installs them')

    record_name = 'baseline-replay' if args.mode == 'baseline' else args.mode
    original_record = json.loads((HERE / f'{record_name}.json').read_text())
    backups = {}
    before = source_hashes()
    head_before = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    try:
        if args.mode == 'baseline':
            for name in original_record['restored_files']:
                path = ROOT / name
                backups[name] = path.read_bytes()
                path.write_bytes(subprocess.check_output(['git', 'show', f"{original_record['base_production']}:{name}"], cwd=ROOT))
        elif args.mode.startswith('mutation-'):
            name = original_record['mutation_source']
            path = ROOT / name
            backups[name] = path.read_bytes()
            change = original_record['replace']
            content = path.read_text()
            if content.count(change['old']) != 1:
                raise RuntimeError('Mutation discriminator no longer matches exactly once')
            path.write_text(content.replace(change['old'], change['new']))

        memory = '6' if args.mode == 'typecheck-exact' else '4'
        command = [args.gate, args.owner, memory, '--', *original_record['command']]
        result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    finally:
        for name, content in backups.items():
            (ROOT / name).write_bytes(content)

    after = source_hashes()
    if before != after:
        raise RuntimeError('Source restoration mismatch')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / f'{args.mode}.log').write_text(result.stdout)
    receipt = {
        'source_head': MANIFEST['source_head'],
        'head_before': head_before,
        'head_after': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'command': command,
        'exit': result.returncode,
        'source_before_sha256': before,
        'source_after_sha256': after,
    }
    (args.output / f'{args.mode}.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(result.stdout, end='')
    print(f'exit={result.returncode}; expected={original_record["exit"]}')
    # Preserve the actual status, including expected RED=1 and admission refusal=75.
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
