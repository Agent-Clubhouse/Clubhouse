from pathlib import Path
import subprocess,hashlib,json,os,time,datetime
root=Path('/Users/masonallen/source/Clubhouse/.clubhouse/agents/lane-full-remote-details/.clubhouse/.local/fixes/connections-pg1-baseline');os.chdir(root)
r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip();p='3733-'+head[:9]+'-pg1-baseline';h=lambda b:hashlib.sha256(b).hexdigest()
assert not subprocess.check_output(['git','diff','--name-only']);assert not subprocess.check_output(['git','diff','--cached','--name-only'])
f={str(x.relative_to(root)):h(x.read_bytes()) for x in sorted((root/'test/fixtures/annex-mobile').rglob('*')) if x.is_file()};assert len(f)==103
assert all(h(subprocess.check_output(['git','show',head+':'+x]))==v for x,v in f.items())
cmd=[str(Path.home()/'.clubhouse/orch/desktop-test-gate.sh'),'full-details','4','--','node_modules/.bin/vitest','run','src/main/services/registered-agent-display-page.test.ts','src/main/services/configured-registered-connections-display.test.ts','--maxWorkers=2','--testNamePattern','same-native-ID Dispatcher|canonical role folder|qualified same-ID Dispatcher']
env=dict(os.environ);env.pop('ANNEX_MOBILE_FIXTURES',None)
meta={'head':head,'tree':tree,'base':'017f7ec9dae90361f09c6c5c8858b3534c95a281','command':cmd,'requestedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ANNEX_MOBILE_FIXTURES_present':False,'fixtureHashesBefore':f}
for i in range(31):
 out=subprocess.run(cmd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if out.returncode!=75:break
 (r/f'{p}-refused-{i}.log').write_text(out.stdout+'\nEXIT_CODE=75\n');print('refused75 waiting60',flush=True);time.sleep(60)
after={str(x.relative_to(root)):h(x.read_bytes()) for x in sorted((root/'test/fixtures/annex-mobile').rglob('*')) if x.is_file()};assert after==f
log=r/f'{p}.log';log.write_text(json.dumps({**meta,'fixtureHashesAfter':after})+'\n'+out.stdout+f'\nEXIT_CODE={out.returncode}\n')
assert out.returncode==1
patch=r/f'{p}-tests.patch';patch.write_bytes(subprocess.check_output(['git','diff','--binary','017f7ec9dae90361f09c6c5c8858b3534c95a281',head]))
paths=subprocess.check_output(['git','diff','--name-only','017f7ec9dae90361f09c6c5c8858b3534c95a281',head],text=True).splitlines();assert all(x.endswith('.test.ts') for x in paths)
res=r/f'{p}-result.json';res.write_text(json.dumps({'head':head,'tree':tree,'testExit':out.returncode,'expectedFailureCapture':True,'onlyTestPaths':paths,'logSHA256':h(log.read_bytes()),'firstF9CombinedArrayShapeAssertionWasNondiscriminating':'This baseline separates 8-entry page shape from first-entry identity; original f9 artifacts unchanged.'},indent=2)+'\n')
manifest=r/f'{p}-manifest.json';manifest.write_text(json.dumps({'head':head,'tree':tree,'files':{x.name:h(x.read_bytes()) for x in [log,patch,res,Path(__file__)]}},indent=2)+'\n')
print(out.stdout);print('EXPECTED_FAILURE_CAPTURED',head,tree,manifest,h(manifest.read_bytes()),flush=True)
