from pathlib import Path
import subprocess,json,hashlib,os,time,datetime
root=Path('/Users/masonallen/source/Clubhouse/.clubhouse/agents/lane-full-remote-details/.clubhouse/.local/fixes/connections-cold-origins');r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');p='3733-1472b73e9-cg1-baseline';h=lambda b:hashlib.sha256(b).hexdigest();os.chdir(root)
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip();assert head=='1472b73e91c6e0f3fecf5e90f3eeaf278cab519f';assert not subprocess.check_output(['git','diff','--name-only']);assert not subprocess.check_output(['git','diff','--cached','--name-only'])
f={str(x.relative_to(root)):h(x.read_bytes()) for x in sorted((root/'test/fixtures/annex-mobile').rglob('*')) if x.is_file()};assert len(f)==103;assert all(h(subprocess.check_output(['git','show',head+':'+x]))==v for x,v in f.items())
cmd=[str(Path.home()/'.clubhouse/orch/desktop-test-gate.sh'),'full-details','4','--','node_modules/.bin/vitest','run','src/main/services/saved-group-connections-display.test.ts','--maxWorkers=2','--testNamePattern','unknown automatic group applicability']
env=dict(os.environ);env.pop('ANNEX_MOBILE_FIXTURES',None);meta={'head':head,'tree':tree,'base':'463515904480d0efd88581e49a61be776d616813','command':cmd,'requestedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fixtureHashesBefore':f,'ANNEX_MOBILE_FIXTURES_present':False};files=[Path(__file__)];deadline=time.monotonic()+1800
for i in range(31):
 out=subprocess.run(cmd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if out.returncode!=75:break
 refused=r/f'{p}-refused-{i}.log';refused.write_text(out.stdout+'\nEXIT_CODE=75\n');files.append(refused);print('refused75 waiting60',flush=True)
 if time.monotonic()+60>deadline:break
 time.sleep(60)
after={str(x.relative_to(root)):h(x.read_bytes()) for x in sorted((root/'test/fixtures/annex-mobile').rglob('*')) if x.is_file()};assert after==f
log=r/f'{p}.log';log.write_text(json.dumps({**meta,'fixtureHashesAfter':after,'actualGateStart':next((s for s in out.stdout.splitlines() if ' START full-details ' in s),None),'actualGateEnd':next((s for s in out.stdout.splitlines() if ' END full-details ' in s),None)})+'\n'+out.stdout+f'\nEXIT_CODE={out.returncode}\n');files.append(log);assert out.returncode==1
patch=r/f'{p}-tests.patch';patch.write_bytes(subprocess.check_output(['git','diff','--binary',meta['base'],head]));files.append(patch)
paths=subprocess.check_output(['git','diff','--name-only',meta['base'],head],text=True).splitlines();assert len(paths)==1 and all(x.endswith('.test.ts') for x in paths)
result=r/f'{p}-result.json';result.write_text(json.dumps({'head':head,'tree':tree,'testExit':out.returncode,'expectedFailureCapture':True,'onlyTestPaths':paths,'productionTreeEqualBase':True,'logSHA256':h(log.read_bytes())},indent=2)+'\n');files.append(result)
(r/f'{p}-initial-manifest.json').write_text(json.dumps({'head':head,'tree':tree,'files':{x.name:h(x.read_bytes()) for x in files}},indent=2)+'\n');print(out.stdout);print('EXPECTED_FAILURE_CAPTURED',head,tree,flush=True)
