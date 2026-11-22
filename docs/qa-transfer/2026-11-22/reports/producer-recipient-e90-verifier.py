import pathlib,json,subprocess,gzip,hashlib,re,collections,xml.etree.ElementTree as ET
p=pathlib.Path(__file__).parent;m=json.load(open(p/'manifest.json'));git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();source=m['source'];proof='7d244fcd153df00668ecac3d0709cece054801e3';base=m['originalCorrection'];red=m['redSource'];prefix='docs/evidence/3613-real-handoff-producer/recipient-correction/'
assert source=='e90eab8bbf53c3592ffdf7ae76cd758311831848' and git('rev-parse',source+'^{tree}').decode().strip()==m['sourceTree'] and git('rev-parse',source+':src').decode().strip()==m['srcTree']
out={'source':source,'sourceTree':m['sourceTree'],'srcTree':m['srcTree'],'proof':proof,'proofTree':git('rev-parse',proof+'^{tree}').decode().strip(),'base':base,'redSource':red}
for a in m['archives']:
 b=git('show',proof+':'+prefix+a['file']);r=gzip.decompress(b);assert len(b)==a['gzipBytes'] and sha(b)==a['gzipSha256'] and len(r)==a['rawBytes'] and sha(r)==a['rawSha256'];assert r==(p/a['file'].removesuffix('.gz')).read_bytes()
paths=[x['path'] for x in m['sourceRows']]
assert len(paths)==4 and set(git('diff','--name-only',base,source).decode().splitlines())==set(paths)
for row in m['sourceRows']:
 for role in ['original','successor']:
  v=row[role];r=git('show',v['source']+':'+row['path']);assert len(r)==v['bytes'] and sha(r)==v['sha256'] and git('rev-parse',v['source']+':'+row['path']).decode().strip()==v['blob']
assert (p/'selected-delta.patch').read_bytes()==git('diff',base,source,'--',*paths)
fixture='test/annex-v2/handoff-producer-admission.test.ts';assert git('rev-parse',red+':src')==git('rev-parse',base+':src');assert git('show',red+':'+fixture)==git('show',source+':'+fixture)==(p/'genuine-baseline-complete-fixture.txt').read_bytes();assert (p/'genuine-baseline-fixture.patch').read_bytes()==git('diff',base,red,'--',fixture)
assert (p/'private-recipient-continuity.patch').read_bytes()==git('diff',red,source,'--',*[f for f in paths if f!=fixture])
bridges=json.load(open(p/'unchanged-closure-bridges.json'));assert len(bridges['bridges'])==7
for b in bridges['bridges']:
 assert sha(b['text'].encode())==b['sha256']
 for ref in [base,source]:
  whole=git('show',ref+':'+b['path']).decode();assert whole.count(b['text'])==1,(ref,b['label'])
lease=bridges['unchangedRegistrationLease'];assert git('rev-parse',base+':'+lease['path']).decode().strip()==git('rev-parse',source+':'+lease['path']).decode().strip()==lease['blob']
out['selectedFiles']=paths;out['sameFixtureOldProductionRed']=True;out['exactUnchangedFragments']=bridges;out['noWholeVerifyCheckOrRuntimeBridgeClaim']=True
# Paired receipts verify exact relevant bytes, not an atomic compile-read seal.
receipts=[]
for c in m['checks']:
 n=str(c['run']);stem=next(a['file'].removesuffix('-before.json.gz') for a in m['archives'] if a['file'].startswith(n+'-') and a['file'].endswith('-before.json.gz'));b=json.load(open(p/(stem+'-before.json')));a=json.load(open(p/(stem+'-after.json')))
 assert b['head']==a['head']==c['source'] and b['tree']==a['tree']==c['tree'] and b['srcTree']==a['srcTree']==git('rev-parse',c['source']+':src').decode().strip();assert b['clean'] is a['clean'] is a['matchesBefore'] is True and b['status']==a['status']=='';assert b['files']==a['files'] and len(b['files'])==15 and b['command']==a['command']==c['command']
 for f,h in b['files'].items():
  if f.startswith('node_modules/'):r=(p/pathlib.Path(f).name).read_bytes()
  else:r=git('show',c['source']+':'+f);assert git('rev-parse',c['source']+':'+f).decode().strip()==h['gitBlob']
  assert len(r)==h['bytes'] and sha(r)==h['sha256'] and hashlib.sha1(b'blob '+str(len(r)).encode()+b'\0'+r).hexdigest()==h['gitBlob']
 raw=(p/(stem+'-original.log')).read_text();assert 'START lane-p2' in raw and 'END lane-p2 rc='+str(c['exit']) in raw and int((p/(stem+'-exit.txt')).read_text())==c['exit'];receipts.append({'run':c['run'],'head':b['head'],'tree':b['tree'],'relevantHashes':15,'cleanBeforeAfter':True,'before':b['capturedAt'],'after':a['capturedAt']})
out['commandReceipts']=receipts;xml=[];total=0;nodes=0
for run in m['xmlRuns']:
 file=next(a['file'].removesuffix('.gz') for a in m['archives'] if a['file'].startswith(str(run['run'])+'-') and a['file'].endswith('.xml.gz'));rows=[]
 for c in ET.parse(p/file).iter('testcase'):
  fail=[n for n in c if n.tag in ['failure','error']];skip=[n for n in c if n.tag=='skipped'];status='fail' if fail else 'skip' if skip else 'pass';assert all(n.attrib.get('type')=='AssertionError' for n in fail)
  rows.append({'name':c.get('name'),'classname':c.get('classname'),'attributes':c.attrib,'status':status,'failures':[{'tag':n.tag,'attributes':n.attrib,'text':n.text} for n in fail],'skipped':[n.attrib for n in skip]})
 assert rows==run['rows'];counts=collections.Counter(x['status'] for x in rows);assert {k:counts[k] for k in ['pass','fail','skip']}==run['counts'];total+=len(rows);nodes+=sum(len(x['failures']) for x in rows);xml.append({'run':run['run'],'source':run['source'],'counts':run['counts'],'failureNodes':sum(len(x['failures']) for x in rows),'selected':[x for x in rows if x['status']!='skip']})
assert total==102 and nodes==24;out.update({'xml':xml,'xmlRows':total,'failureNodes':nodes,'archiveCount':len(m['archives'])})
# Full compiler input list and tracked byte inventory independently bound to source.
inv=json.load(open(p/'122-producer-recipient-types-input-inventory-after.json'));log=(p/'122-producer-recipient-types-original.log').read_text();inputs=[l for l in log.splitlines() if l.startswith('/')];assert len(inputs)==len(inv['inputs'])==3958 and inputs==[x['path'] for x in inv['inputs']] and not re.search(r'error TS\d+:',log)
root='/Users/masonallen/source/Clubhouse/.clubhouse/agents/lane-3613-p2-routes/node_modules/.cache/3613-p7w-remaining-consumers-work';tree={l.split('\t')[1]:l.split('\t')[0].split()[2] for l in git('ls-tree','-r',source).decode().splitlines()};tracked=[]
for i in inv['inputs']:
 assert i['path'].startswith(root+'/');rel=i['path'][len(root)+1:]
 if rel in tree:tracked.append((rel,i,tree[rel]))
proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE);b=proc.communicate(('\n'.join(t[2] for t in tracked)+'\n').encode())[0];off=0
for rel,i,obj in tracked:
 end=b.index(b'\n',off);head=b[off:end].decode().split();n=int(head[2]);r=b[end+1:end+1+n];off=end+n+2;assert head[0]==obj and n==i['bytes'] and sha(r)==i['sha256']
assert off==len(b);cfg=json.load(open(p/'79-producer-candidate-tsconfig.json'));assert cfg==json.loads(gzip.decompress(git('show',base+':docs/evidence/3613-real-handoff-producer/fence-correction/79-producer-candidate-tsconfig.json.gz')))
assert all(root+'/'+f.removeprefix('../../../') in inputs for f in cfg['files']) and len(cfg['files'])==2
prodroots={f for f in tree if f.startswith('src/') and pathlib.Path(f).suffix in {'.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'} and not f.endswith(('.test.ts','.test.tsx','.qa.ts'))};prodroots={f for f in prodroots if not(f.endswith('.mjs') and (f[:-4]+'.mts' in prodroots or f[:-4]+'.d.mts' in prodroots))};assert len(prodroots)==2465
lint=json.load(open(p/'123-producer-recipient-eslint-original.json'));assert len(lint)==3 and all(x['errorCount']==x['warningCount']==0 for x in lint)
out['compiler']={'actualExit':0,'orderedInputs':3958,'trackedContentHashesVerified':len(tracked),'dependencyHashesOwnerObservedAfterExecution':3958-len(tracked),'productionRoots':2465,'completeAdditionalFixtureRoots':2,'totalRoots':2467,'bothCompleteFixturesPresent':True,'atomicReadSeal':False};out['lint']={'files':3,'errors':0,'warnings':0}
for f in ['docs/evidence/3613-real-handoff-producer/candidate','docs/evidence/3613-real-handoff-producer/baseline','docs/evidence/3613-real-handoff-producer/fence-correction','test/fixtures','docs/evidence/3613-native-handoff-ingress','docs/evidence/3613-reverse-handoff','docs/evidence/3613-handoff-reverse-sync']:
 assert git('rev-parse',base+':'+f)==git('rev-parse',source+':'+f)==git('rev-parse',proof+':'+f)
out['protectedHistoricalTreesEqual']=True;out['manifestSha256']=sha((p/'manifest.json').read_bytes());out['readmeSha256']=sha((p/'README.md').read_bytes());out['disposition']='APPROVE exact residual CP1-R1; combined scoped PR-ready with original source-specific proof attribution and remaining composition/hosted gates'
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k not in ['xml','exactUnchangedFragments']},indent=2))
