import base64,datetime,hashlib,json,os,re,shutil,stat,subprocess,tempfile
from pathlib import Path
ROOT=Path('/Users/masonallen/source/Clubhouse/.clubhouse/agents/auto-reset-policy-design')
LIVE=Path('/Users/masonallen/.clubhouse/orch/desktop-test-gate.sh')
BASE=Path('/tmp/clubhouse-desktop-test.swapbase');LOCK=Path('/tmp/clubhouse-desktop-test.lock')
E=Path('/Users/masonallen/.clubhouse/orch/evidence/desktop-gate-repair')
OUT=E/'274a-activation';OLD='61797476544935859d70911b17cab44fae4c2575180498ab6d9388a79f8fcf16';NEW='d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3';HEAD='274a39410c714931abfd38369d53b9101d5b60c5'
def sha(body):return hashlib.sha256(body).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
def baseline():
 st=BASE.lstat();assert stat.S_ISREG(st.st_mode),'Baseline not regular'
 body=BASE.read_bytes();assert re.fullmatch(rb'[0-9]+\n?',body),'Baseline corrupt: inspect, never reset'
 return {'sha256':sha(body),'mtimeNs':st.st_mtime_ns,'mode':stat.S_IMODE(st.st_mode),'bytesBase64':base64.b64encode(body).decode()}
def busy():
 assert not os.path.lexists(LOCK),'Active/stale slot exists: STOP, do not remove'
 found=[]
 raw=subprocess.check_output(['ps','-axo','pid=,comm=,args='],text=True)
 for line in raw.splitlines():
  row=line.strip().split(None,2)
  if len(row)!=3:continue
  pid,comm,args=row;name=Path(comm).name
  if int(pid)==os.getpid():continue
  kind=None
  if name=='node' and any(x in args for x in ['vitest','tsc --noEmit','typescript/bin/tsc']):kind='active-node-test/compiler'
  if name in ['zsh','bash','sh'] and re.search(r'(^|\s)\S*desktop-test-gate\.sh(\s|$)',args):kind='active-gate-shell'
  if kind:found.append({'pid':int(pid),'class':kind})
 assert not found,'Active gate/test child: '+json.dumps(found)
 return {'slotAbsent':True,'activeGateOrNodeTestChildren':found,'rawArgumentsRetained':False}
def prerequisites():
 receipts={}; baseline_seal=None
 for name in ['274a39410-full23-preactivation','274a39410-original3-preactivation','274a39410-floor-preactivation']:
  directory=E/name;r=json.loads((directory/'receipt.json').read_text());raw=(directory/'raw.txt').read_bytes()
  assert r['exitCode']==0 and r['sourceSealEqual'] and r['liveGateUnchanged'] and r['liveBaselineUnchanged'],name
  assert r['before']['head']==r['after']['head']==HEAD and r['before']['tree']==r['after']['tree']=='e3ae0e77c55a1da6017ed3f85129e8a64bac85b6',name
  assert r['rawSha256']==sha(raw),name
  assert r['before']['liveGateSha256']==r['after']['liveGateSha256']==OLD,name
  if baseline_seal is None:baseline_seal=r['after']['liveBaseline']
  assert baseline_seal==r['after']['liveBaseline'],name
  if 'full23' in name:assert re.search(rb'Ran 23 tests in .*\n\nOK',raw),name
  else:
   assert b'AssertionError: 0 != 75' in raw,name
   observations=[json.loads(line) for line in raw.decode().splitlines() if line.startswith('{"mutant":')]
   assert len(observations)==(3 if 'original3' in name else 1),name
   assert all(x['killed'] and x['exitCode']==1 for x in observations),name
  receipts[name]={'receiptSha256':sha((directory/'receipt.json').read_bytes()),'rawSha256':r['rawSha256']}
 return receipts
OUT.mkdir(exist_ok=False)
record={'scope':'Explicitly authorized conditional reviewed gate activation only, no product acceptance','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scriptSha256':sha(Path(__file__).read_bytes()),'mutated':False}
temp=None;identity=None
try:
 record['prerequisites']=prerequisites();assert git('rev-parse','HEAD')==HEAD and git('status','--porcelain','--untracked-files=all')==''
 candidate=(ROOT/'test/research/desktop-gate-repair/candidate.zsh').read_bytes();assert sha(candidate)==NEW
 assert candidate==subprocess.check_output(['git','show',HEAD+':test/research/desktop-gate-repair/candidate.zsh'],cwd=ROOT)
 original=LIVE.read_bytes();st=LIVE.lstat();assert stat.S_ISREG(st.st_mode) and sha(original)==OLD
 record['before']={'liveSha256':sha(original),'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid,'baseline':baseline(),'activity':busy()}
 last=json.loads((E/'274a39410-floor-preactivation/receipt.json').read_text())['after']['liveBaseline']
 assert {k:record['before']['baseline'][k] for k in ['sha256','mtimeNs']}==last,'Intervening baseline change'
 (OUT/'preconditions.json').write_text(json.dumps(record,indent=2)+'\n')
 backup=LIVE.with_name(LIVE.name+'.backup-61797476-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
 assert not os.path.lexists(backup);shutil.copy2(LIVE,backup)
 assert sha(backup.read_bytes())==OLD and stat.S_IMODE(backup.stat().st_mode)==stat.S_IMODE(st.st_mode)
 record['backup']={'path':str(backup),'sha256':sha(backup.read_bytes()),'mode':stat.S_IMODE(backup.stat().st_mode)}
 fd,name=tempfile.mkstemp(prefix='.desktop-test-gate-274a-',dir=LIVE.parent);temp=Path(name)
 with os.fdopen(fd,'wb') as out:
  os.fchmod(out.fileno(),stat.S_IMODE(st.st_mode));out.write(candidate);out.flush();os.fsync(out.fileno());identity=os.fstat(out.fileno())
 assert temp.stat().st_uid==st.st_uid and temp.stat().st_gid==st.st_gid,'Staged owner/group mismatch'
 record['immediatePreReplaceActivity']=busy();assert sha(LIVE.read_bytes())==OLD and baseline()==record['before']['baseline'],'Concurrent live/baseline change'
 os.replace(temp,LIVE);temp=None;record['mutated']=True
 record['after']={'liveSha256':sha(LIVE.read_bytes()),'mode':stat.S_IMODE(LIVE.stat().st_mode),'uid':LIVE.stat().st_uid,'gid':LIVE.stat().st_gid,'baseline':baseline(),'activity':busy()}
 assert record['after']['liveSha256']==NEW and record['after']['mode']==record['before']['mode']
 assert record['after']['baseline']==record['before']['baseline'],'Baseline changed during activation'
 record['status']='installed_hash_verified_no_admission_or_dryrun_yet'
except Exception as error:
 record['status']='STOP_REVIEW';record['error']=str(error);raise
finally:
 if temp is not None and temp.exists():
  got=temp.lstat()
  if identity and got.st_dev==identity.st_dev and got.st_ino==identity.st_ino:temp.unlink()
 record['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();(OUT/'activation.json').write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record,indent=2))
