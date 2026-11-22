import pathlib,json,subprocess,hashlib,gzip,xml.etree.ElementTree as ET,collections,re
p=pathlib.Path(__file__).parent;m=json.load(open(p/'manifest.json'));git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();source=m['source'];proof='ef99265da9faddddf522c2c294745d86d593d78d';base=m['base'];prod=m['productionSource'];prefix='docs/evidence/3613-real-handoff-producer/candidate/'
out={'source':source,'sourceTree':git('rev-parse',source+'^{tree}').decode().strip(),'proof':proof,'proofTree':git('rev-parse',proof+'^{tree}').decode().strip(),'srcTree':git('rev-parse',source+':src').decode().strip()};assert out['sourceTree']==m['sourceTree'];assert out['srcTree']==m['srcTree']==git('rev-parse',prod+':src').decode().strip()
for f in m['files']:
 assert git('rev-parse',source+':'+f['path']).decode().strip()==f['sourceBlob']
 if f['baseBlob']:assert git('rev-parse',base+':'+f['path']).decode().strip()==f['baseBlob']
assert git('diff','--binary',base,source,'--',*[x['path'] for x in m['files']])==(p/'105-producer-selected-source.patch').read_bytes()
for a in m['archives']:
 b=git('show',proof+':'+prefix+a['archive']);raw=gzip.decompress(b);assert sha(b)==a['gzipSha256'] and sha(raw)==a['sha256'] and len(raw)==a['bytes'];assert raw==(p/a['archive'].removesuffix('.gz')).read_bytes()
out['archives']=len(m['archives']);runs=[];total=0;mutants=[]
for e in m['executions']:
 t=ET.parse(p/(e['id']+'-original.xml'));cases=[]
 for c in t.iter('testcase'):
  fs=[n for n in c if n.tag in ['failure','error']];s='FAIL' if fs else 'SKIP' if c.find('skipped') is not None else 'PASS'
  cases.append({'name':c.get('name'),'class':c.get('classname'),'status':s,'failureNodes':[{'type':n.get('type'),'message':n.get('message'),'text':n.text} for n in fs]})
 assert cases==e['cases'] and dict(collections.Counter(c['status'] for c in cases))==e['counts'];total+=len(cases)
 log=(p/(e['id']+'-original.log')).read_text();assert 'START lane-p2' in log and 'maxWorkers=1' in log and 'END lane-p2 rc='+str(e['exit']) in log
 # Source association is manifest + lineage/source archives, not an embedded atomic execution seal.
 if e['sourcePublishedViaCandidateAncestry']:
  subprocess.check_call(['git','merge-base','--is-ancestor',e['source'],source])
 else:
  assert git('rev-parse',e['source']+'^').decode().strip()==prod
  assert (p/(e['id']+'-source.txt')).read_text().strip()==e['source']
  assert (p/(e['id']+'-source.patch')).read_bytes()==git('diff',prod,e['source'])
  paths=git('diff','--name-only',prod,e['source']).decode().splitlines();assert len(paths)==1
  b=git('show',e['source']+':'+paths[0]);assert b==(p/(e['id']+'-'+pathlib.Path(paths[0]).name)).read_bytes()
  mutants.append({'source':e['source'],'localOnly':True,'path':paths[0],'fullSourceSha256':sha(b),'patchSha256':sha((p/(e['id']+'-source.patch')).read_bytes()),'counts':e['counts'],'failureNames':[c['name'] for c in cases if c['status']=='FAIL']})
 runs.append({'id':e['id'],'source':e['source'],'counts':e['counts'],'selected':[c for c in cases if c['status']!='SKIP']})
assert total==357 and len(runs)==14 and len(mutants)==5;assert sum(x['counts'].get('FAIL',0) for x in mutants)==6
out.update({'runtime':runs,'actualXmlRows':total,'mutants':mutants})
checks=[]
for c in m['checks']:
 if c['kind']=='types':
  log=(p/c['receipt']['archive'].removesuffix('.gz')).read_text();assert re.search(r'END lane-p2 rc='+str(c['exit'])+r'\b',log);assert len(re.findall(r'error TS\d+:',log))==c['diagnostics'];checks.append({'source':c['source'],'kind':'types','exit':c['exit'],'diagnostics':c['diagnostics']})
 else:
  d=json.load(open(p/c['json']['archive'].removesuffix('.gz')));assert len(d)==8 and all(x['errorCount']==x['warningCount']==0 for x in d);checks.append({'source':c['source'],'kind':'lint','files':8,'errors':0,'warnings':0})
cfg=json.load(open(p/'79-producer-candidate-tsconfig.json'));assert cfg=={'extends':'../../../tsconfig.json','compilerOptions':{'noEmit':True},'include':['../../../src/**/*'],'files':['../../../test/annex-v2/handoff-producer-admission.test.ts','../../../src/main/services/clubhouse-mcp/tools/handoff-tools.test.ts']}
rootcfg=json.loads(git('show',source+':tsconfig.json'));assert git('show',source+':tsconfig.json')==git('show',base+':tsconfig.json')
paths=git('ls-tree','-r','--name-only',source).decode().splitlines();prodroots={f for f in paths if f.startswith('src/') and pathlib.Path(f).suffix in {'.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'} and not f.endswith(('.test.ts','.test.tsx','.qa.ts'))};prodroots={f for f in prodroots if not(f.endswith('.mjs') and (f[:-4]+'.mts' in prodroots or f[:-4]+'.d.mts' in prodroots))};assert len(prodroots)==2465
out['checks']=checks;out['config']={'actualArchivedConfig':cfg,'productionRootsReconstructed':2465,'additionalCompleteFixtures':2,'totalRoots':2467,'afterExecutionRootCountsOnly':True,'final101ContainsNoListFilesHashInventory':True,'atomicReadSeal':False};out['manifestSha256']=sha((p/'manifest.json').read_bytes());out['readmeSha256']=sha((p/'README.md').read_bytes())
# Protected boundary scope: only six production files + coupled src fixture.
changed=git('diff','--name-only',base,source,'--','src').decode().splitlines();assert set(changed)=={f['path'] for f in m['files'] if f['path'].startswith('src/')};out['srcChangedPaths']=changed
for f in ['test/fixtures','docs/evidence/3613-native-handoff-ingress','docs/evidence/3613-reverse-handoff','docs/evidence/3613-handoff-reverse-sync']:
 if f=='docs/evidence/3613-native-handoff-ingress':
  # Native evidence directory is entirely inherited here; added producer evidence is separate.
  pass
 assert git('rev-parse',base+':'+f)==git('rev-parse',source+':'+f)==git('rev-parse',proof+':'+f)
out['protectedPhoneNativeLowerTreesEqual']=True
out['disposition']='BLOCK: CP1 consumed approval/context after-positive verify-await gap; CP2 unawaited source observation revision can be blessed'
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['runtime','mutants']},indent=2));print('MUTANTS',len(mutants),'SEMANTICFAIL',sum(x['counts'].get('FAIL',0) for x in mutants))
