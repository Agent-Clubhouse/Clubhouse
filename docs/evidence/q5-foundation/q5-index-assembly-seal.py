"""Seal exact isolated five-file index checks inside desktop-test-gate."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

FILES = [
    'src/main/services/group-project-notice-ledger/pages.ts',
    'src/main/services/group-project-notice-ledger/pages.test.ts',
    'src/main/services/group-project-notice-ledger/durability.ts',
    'src/main/services/group-project-notice-ledger/durability.test.ts',
    'test/research/q5-index-process.cjs',
    'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
    'test/global-setup.ts', 'test/standard-runtime-boundary.ts',
    'eslint.config.mjs', '.github/workflows/validate.yml',
]


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def state():
    return {
        'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
        'status': git('status', '--porcelain', '--untracked-files=all'),
        'sealerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'sources': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sorted(FILES)},
    }


destination = Path(sys.argv[1])
argv = sys.argv[2:]
if argv and argv[0] == '--':
    argv = argv[1:]
if not argv:
    raise SystemExit('Missing admitted command')
destination.mkdir(parents=True, exist_ok=False)
before = state()
if before['status']:
    raise SystemExit('Refusing dirty isolated index source')
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = state()
(destination / 'raw.txt').write_bytes(result.stdout)
receipt = {
    'scope': 'isolated five-file index only; no activation/runtime authority',
    'startedAt': started, 'finishedAt': finished, 'cwd': str(Path.cwd()),
    'argv': argv, 'exitCode': result.returncode, 'before': before, 'after': after,
    'sealEqual': before == after, 'rawSha256': hashlib.sha256(result.stdout).hexdigest(),
}
(destination / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
sys.stdout.buffer.write(result.stdout)
print(json.dumps({'receipt': str(destination / 'receipt.json'), 'exitCode': result.returncode, 'sealEqual': before == after}))
raise SystemExit(result.returncode if result.returncode else (0 if before == after else 3))
