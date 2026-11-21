import datetime,hashlib,json,os,subprocess,sys
from pathlib import Path
OUT=Path('/Users/masonallen/.clubhouse/orch/evidence/desktop-gate-repair/274a-activation')
LIVE=Path('/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh');BASE=Path('/tmp/clubhouse-desktop-test.swapbase');SLOT=Path('/tmp/clubhouse-desktop-test.lock')
ROOT=Path('/Users/masonallen/source/Clubhouse/.clubhouse/agents/auto-reset-policy-design')
DEST=Path('/Users/masonallen/.clubhouse/orch/evidence/q5-implementation/224e0797d-root-state-first-admission-d45')
assert not DEST.exists() and not (OUT/'first-normal.json').exists(),'First caller already attempted'
assert 'FAKE_MODEL' not in os.environ and not any('gate-fake-only-' in x for x in os.environ.get('PATH','').split(os.pathsep)),'Fake environment forbidden for actual admission'
assert hashlib.sha256(LIVE.read_bytes()).hexdigest()=='d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()=='224e0797daf1b6e696b46ddd82bea5d79894ae4c'
command=[str(LIVE),'q5-ledger','4','--','python3','/Users/masonallen/.clubhouse/orch/evidence/q5-implementation/q5-root-state-seal.py',str(DEST),'--','./node_modules/.bin/vitest','run','--project','main','src/main/services/group-project-notice-ledger/sparse-state.test.ts','src/main/services/group-project-notice-ledger/sparse-reader.test.ts','src/main/services/group-project-notice-ledger/state.test.ts','src/main/services/group-project-notice-ledger/intervals.test.ts','--maxWorkers=2']
started=datetime.datetime.now(datetime.timezone.utc).isoformat();before={'gateSha256':hashlib.sha256(LIVE.read_bytes()).hexdigest(),'baselineSha256':hashlib.sha256(BASE.read_bytes()).hexdigest(),'baselineMtimeNs':BASE.stat().st_mtime_ns,'slotAbsent':not os.path.lexists(SLOT)}
(OUT/'first-normal-started.json').write_text(json.dumps({'startedAt':started,'command':command,'before':before},indent=2)+'\n')
with (OUT/'first-normal.raw.txt').open('wb') as output:
 p=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for line in iter(p.stdout.readline,b''):
  output.write(line);output.flush();sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
 rc=p.wait()
after={'gateSha256':hashlib.sha256(LIVE.read_bytes()).hexdigest(),'baselineSha256':hashlib.sha256(BASE.read_bytes()).hexdigest(),'baselineBytes':BASE.read_text(),'baselineMtimeNs':BASE.stat().st_mtime_ns,'slotAbsent':not os.path.lexists(SLOT)}
r={'scope':'ONE actual normal targeted four-suite root caller, no retry/compiler/product acceptance','startedAt':started,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,'exitCode':rc,'before':before,'after':after,'childReceiptExists':(DEST/'receipt.json').exists(),'rawSha256':hashlib.sha256((OUT/'first-normal.raw.txt').read_bytes()).hexdigest(),'procedureSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
(OUT/'first-normal.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2));raise SystemExit(rc)
