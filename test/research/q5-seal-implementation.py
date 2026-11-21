"""Run a bounded Q5 check INSIDE desktop-test-gate with exact source receipts."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def state():
    files = [str(p) for p in Path('src/main/services/group-project-notice-ledger').glob('*.ts')]
    files += ['test/research/q5-journal-process.cjs', 'test/research/q5-entered-mutation.cjs', 'test/research/q5-installation-process.cjs', 'test/research/q5-index-process.cjs', 'test/research/q5-seal-implementation.py',
              'docs/design/q5-durable-notice-ledger.md', 'package-lock.json', 'tsconfig.json',
              'vitest.config.ts', 'test/global-setup.ts', 'test/standard-runtime-boundary.ts']
    return {'head': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'status': git('status', '--porcelain', '--untracked-files=all'),
            'sources': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest() for name in sorted(files)}}


destination = Path(sys.argv[1])
argv = sys.argv[2:]
if argv and argv[0] == '--':
    argv = argv[1:]
if not argv:
    raise SystemExit('Missing admitted command')
destination.mkdir(parents=True, exist_ok=False)
before = state()
if before['status']:
    raise SystemExit('Refusing dirty Q5 source')
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
after = state()
(destination / 'raw.txt').write_bytes(result.stdout)
receipt = {'startedAt': started, 'finishedAt': finished, 'cwd': str(Path.cwd()), 'argv': argv,
           'exitCode': result.returncode, 'before': before, 'after': after, 'sealEqual': before == after,
           'rawSha256': hashlib.sha256(result.stdout).hexdigest()}
(destination / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
sys.stdout.buffer.write(result.stdout)
print(json.dumps({'receipt': str(destination / 'receipt.json'), 'exitCode': result.returncode, 'sealEqual': before == after}))
raise SystemExit(result.returncode if result.returncode else (0 if before == after else 3))
