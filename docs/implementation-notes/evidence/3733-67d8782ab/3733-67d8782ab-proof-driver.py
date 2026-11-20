from pathlib import Path
import datetime,difflib,hashlib,json,subprocess,sys,time,os
cfg=json.loads(Path(sys.argv[1]).read_text());root=Path(cfg['root']);reports=Path(cfg['reports']);prefix=cfg['prefix'];head=cfg['head'];tree=cfg['tree'];os.chdir(root)
def digest(b):return hashlib.sha256(b).hexdigest()
def git(*args):return subprocess.check_output(['git',*args])
def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def clean():
 assert git('rev-parse','HEAD').decode().strip()==head and git('rev-parse','HEAD^{tree}').decode().strip()==tree
 assert not git('diff','--name-only') and not git('diff','--cached','--name-only')
def fixtures():return {str(f.relative_to(root)):digest(f.read_bytes()) for f in sorted((root/'test/fixtures/annex-mobile').rglob('*')) if f.is_file()}
clean();baseline=fixtures();assert len(baseline)==103
assert {p:digest(git('show',head+':'+p)) for p in baseline}==baseline
(reports/f'{prefix}-committed-fixtures.json').write_text(json.dumps({'head':head,'tree':tree,'count':103,'sha256':baseline},indent=2)+'\n')
deadline=time.monotonic()+1800
required=[reports/f'{prefix}-{name}' for name in ['controls.json','configuration.json','source-tests.patch','source-identities.json','scope.json','proof-driver.py','proof-builder.py','proof-runner.py','committed-fixtures.json']]
def tests(files,pattern=None):return ['node_modules/.bin/vitest','run',*files,'--maxWorkers=2',*(['--testNamePattern',pattern] if pattern else [])]
def execute(name,args,extra=None):
 env=dict(os.environ);env.pop('ANNEX_MOBILE_FIXTURES',None);assert 'ANNEX_MOBILE_FIXTURES' not in env
 cmd=[str(Path.home()/'.clubhouse/orch/desktop-test-gate.sh'),'full-details','6' if name=='tsc' else '4','--',*args]
 before=fixtures();assert before==baseline
 meta={'head':head,'tree':tree,'cwd':str(root),'command':cmd,'requestedAt':utc(),'ANNEX_MOBILE_FIXTURES_present':False,'fixtureHashesBefore':before,**(extra or {})}
 for attempt in range(31):
  meta['lastAttemptedAt']=utc();result=subprocess.run(cmd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  if result.returncode!=75:break
  file=reports/f'{prefix}-{name}-refused-attempt{attempt+1}.log';file.write_text(json.dumps(meta,sort_keys=True)+'\n'+result.stdout+'\nEXIT_CODE=75\n');required.append(file)
  print(name,'refused75 at',utc(),'waiting60s',flush=True)
  if attempt==30 or time.monotonic()+60>deadline:break
  time.sleep(60)
 after=fixtures();assert after==before
 meta.update({'fixtureHashesAfter':after,'fixturesUnchanged':True,'actualGateStart':next((s for s in result.stdout.splitlines() if ' START full-details ' in s),None),'actualGateEnd':next((s for s in result.stdout.splitlines() if ' END full-details ' in s),None)})
 file=reports/f'{prefix}-{name}.log';file.write_text(json.dumps(meta,sort_keys=True)+'\n'+result.stdout+f'\nEXIT_CODE={result.returncode}\n');required.append(file)
 print(name,'exit',result.returncode,'at',utc(),flush=True)
 return result,file
for control in json.loads((reports/f'{prefix}-controls.json').read_text()):
 clean();file=root/control['file'];original=file.read_bytes();source=original.decode()
 for old,new in control['changes']:assert source.count(old)==1,(control['name'],old,source.count(old));source=source.replace(old,new)
 mutated=source.encode();assert mutated!=original
 patch=reports/f"{prefix}-{control['name']}.patch";patch.write_text(''.join(difflib.unified_diff(original.decode().splitlines(True),source.splitlines(True),fromfile=control['file'],tofile=control['file'])));required.append(patch)
 log=None
 try:
  file.write_bytes(mutated)
  result,log=execute(control['name'],tests(control['tests'],control['pattern']),{'file':control['file'],'originalSHA256':digest(original),'mutatedSHA256':digest(mutated),'mutationPatch':patch.name,'evidenceLimit':control['evidenceLimit']})
 finally:
  file.write_bytes(original);clean();assert digest(file.read_bytes())==digest(original)
  if log:
   with log.open('a') as stream:stream.write(json.dumps({'restoredSHA256':digest(file.read_bytes()),'matchesOriginal':True,'headAfter':head,'treeAfter':tree,'trackedWorktreeCleanAfter':True})+'\n')
 assert result.returncode not in [0,75],control['name']+' ineffective or unadmitted'
clean();result,_=execute('green',tests(cfg['green']));clean();assert result.returncode==0
result,_=execute('route-client',tests(cfg['routeFiles'],cfg['routePattern']));clean();assert result.returncode==0
result,_=execute('tsc',['node_modules/.bin/tsc','--noEmit']);clean();assert result.returncode==0
assert len(required)==len(set(required)) and all(p.is_file() for p in required)
manifest={'head':head,'tree':tree,'requiredArtifacts':[p.name for p in required],'files':{p.name:digest(p.read_bytes()) for p in required}}
(reports/f'{prefix}-initial-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('ALL_CONTROLS_RESTORED_AND_GREEN',head,tree,utc(),flush=True)
