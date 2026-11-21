import datetime,hashlib,json,subprocess,sys
from pathlib import Path
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],text=True).strip()
def state():
 files=sorted(Path('test/research/desktop-gate-repair').glob('*'))
 live=Path('/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh');base=Path('/tmp/clubhouse-desktop-test.swapbase')
 return {'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'status':git('status','--porcelain','--untracked-files=all'),'sources':{str(p):sha(p) for p in files if p.is_file()},'sealerSha256':sha(Path(__file__)),'liveGateSha256':sha(live),'liveBaseline':{'sha256':sha(base),'mtimeNs':base.stat().st_mtime_ns} if base.exists() else None}
dest=Path(sys.argv[1]);argv=sys.argv[2:];argv=argv[1:] if argv and argv[0]=='--' else argv
dest.mkdir(exist_ok=False);before=state()
if before['status']:raise SystemExit('Dirty repair source')
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (dest/'raw.txt').open('wb') as output:
 p=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for line in iter(p.stdout.readline,b''):
  output.write(line);output.flush();sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
 rc=p.wait()
finished=datetime.datetime.now(datetime.timezone.utc).isoformat();after=state()
r={'scope':'Authorized LIGHT fake-resource shell simulation ONLY; no live gate invocation, heavy admission, baseline repair or real child test','command':argv,'exitCode':rc,'startedAt':started,'finishedAt':finished,'before':before,'after':after,'sourceSealEqual':{k:v for k,v in before.items() if k not in ['liveBaseline','liveGateSha256']}=={k:v for k,v in after.items() if k not in ['liveBaseline','liveGateSha256']},'liveGateUnchanged':before['liveGateSha256']==after['liveGateSha256'],'liveBaselineUnchanged':before['liveBaseline']==after['liveBaseline'],'rawSha256':sha(dest/'raw.txt')}
(dest/'receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'receipt':str(dest/'receipt.json'),'exitCode':rc,'sourceSealEqual':r['sourceSealEqual'],'liveGateUnchanged':r['liveGateUnchanged'],'liveBaselineUnchanged':r['liveBaselineUnchanged']}))
raise SystemExit(rc if rc else (0 if r['sourceSealEqual'] and r['liveGateUnchanged'] and r['liveBaselineUnchanged'] else 3))
