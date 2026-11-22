import pathlib,json,subprocess,hashlib,gzip,re,collections,xml.etree.ElementTree as ET
p=pathlib.Path(__file__).parent;m=json.load(open(p/'manifest.json'));git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();source=m['source'];base=m['base'];proof='76656abec9b5f9a0fb6f6cd12b74178efcbf7ae2';pre='docs/evidence/3613-real-handoff-producer/fixture-teardown-correction/';path=m['selectedFile'];src=git('show',source+':'+path)
assert git('rev-parse',source+'^{tree}').decode().strip()==m['sourceTree'];assert git('rev-parse',source+':src').decode().strip()==m['srcTree']==git('rev-parse',base+':src').decode().strip();assert git('diff','--name-only',base,source).decode().splitlines()==[path]
out={'source':source,'sourceTree':m['sourceTree'],'srcTree':m['srcTree'],'proof':proof,'proofTree':git('rev-parse',proof+'^{tree}').decode().strip(),'changedFile':path}
for a in m['archives']:
 b=git('show',proof+':'+pre+a['file']);raw=gzip.decompress(b);assert len(b)==a['gzipBytes'] and sha(b)==a['gzipSha256'] and len(raw)==a['bytes'] and sha(raw)==a['sha256'] and raw==(p/a['file'].removesuffix('.gz')).read_bytes()
for f in p.glob('source-*.ts'):
 ref=re.match(r'source-([a-f0-9]{40})-',f.name)[1];assert f.read_bytes()==git('show',ref+':'+path)
for f in p.glob('delta-*.patch'):
 a,b=re.match(r'delta-([a-f0-9]{40})-([a-f0-9]{40})\.patch',f.name).groups();assert f.read_bytes()==git('diff',a,b,'--',path)
# Full old52 bodies unchanged, not merely selected assertions.
anchor="  it('keeps actual fixture preparation alive until teardown settles it'";old=git('show',base+':'+path);body=old[old.index(anchor.encode()):];assert src[src.index(anchor.encode()):]==body==(p/'unchanged-old52-test-bodies.txt').read_bytes();assert len(body)==45893 and sha(body)==m['bridges']['old52TestBodies']['sha256']
fragments=[('146-original-owned-wrapper-and-cleanup.txt','146OriginalOwnedWrapperAndCleanup',m['runs'][0]['head']),('151-original-before-forward-metadata.txt','151OriginalBeforeForwardMetadata',next(r['head'] for r in m['runs'] if r['prefix'].startswith('151-')))]
for name,key,ref in fragments:
 b=(p/name).read_bytes();assert len(b)==m['bridges'][key]['bytes'] and sha(b)==m['bridges'][key]['sha256'] and old.count(b)==1 and git('show',ref+':'+path).count(b)==1
out['sourceBridges']={'oneFixture217plus15minus':True,'entireSrcTreeIdenticalToC165':True,'old52BodiesBytes':len(body),'old52BodiesSha256':sha(body),'146OriginalFragmentBytes':1584,'151OriginalFragmentBytes':836}
receipts=[];xml=[];total=0
for run in m['runs']:
 stem=run['prefix'];b=json.load(open(p/(stem+'-before.json')));a=json.load(open(p/(stem+'-after.json')))
 assert b['head']==a['head']==run['head'] and b['tree']==a['tree']==run['tree'] and b['srcTree']==a['srcTree']==run['srcTree'];assert b['clean'] is a['clean'] is a['matchesBefore'] is True and b['status']==a['status']=='';assert b['files']==a['files'] and len(b['files'])==16 and b['command']==a['command']==run['command']
 for f,h in b['files'].items():
  if f.startswith('node_modules/'):r=(p/pathlib.Path(f).name).read_bytes()
  else:r=git('show',run['head']+':'+f);assert git('rev-parse',run['head']+':'+f).decode().strip()==h['gitBlob']
  assert len(r)==h['bytes'] and sha(r)==h['sha256'] and hashlib.sha1(b'blob '+str(len(r)).encode()+b'\0'+r).hexdigest()==h['gitBlob']
 log=(p/(stem+'-original.log')).read_text();assert 'START lane-p2' in log and 'END lane-p2 rc='+str(run['exit']) in log and int((p/(stem+'-exit.txt')).read_text())==run['exit'];receipts.append({'prefix':stem,'head':run['head'],'tree':run['tree'],'cleanBeforeAfter':True,'relevantHashes':16,'exit':run['exit']})
 if 'counts' in run:
  rows=[]
  for c in ET.parse(p/(stem+'-original.xml')).iter('testcase'):
   fails=[x for x in c if x.tag in ['failure','error']];s='fail' if fails else 'skip' if c.find('skipped') is not None else 'pass';rows.append({'name':c.get('name'),'classname':c.get('classname'),'result':s,'failures':[ET.tostring(x,encoding='unicode') for x in fails]})
  assert rows==json.load(open(p/(stem+'-testcase-rows.json')));assert dict(collections.Counter(x['result'] for x in rows))==run['counts'];assert len(rows)==run['declarations'] and sum(len(x['failures']) for x in rows)==run['failureNodes'];total+=len(rows);xml.append({'prefix':stem,'head':run['head'],'counts':run['counts'],'failureNodes':run['failureNodes'],'selected':[x for x in rows if x['result']!='skip']});assert '--maxWorkers=1' in log
 elif 'diagnostics' in run:assert len(re.findall(r'error TS\d+:',log))==len(run['diagnostics'])
assert len(xml)==4 and total==226;out.update({'receipts':receipts,'xml':xml,'xmlRows':total,'archiveCount':len(m['archives'])})
inv=json.load(open(p/'154-owner-observed-after-execution-input-inventory.json'));log=(p/'154-fixture-teardown-types-original.log').read_text();actual=[l for l in log.splitlines() if l.startswith('/')];assert len(actual)==len(inv)==3959 and actual==[x['path'] for x in inv] and not re.search(r'error TS\d+:',log)
tracked=[i for i in inv if i['tracked']];assert len(tracked)==2471;tree={l.split('\t')[1]:l.split('\t')[0].split()[2] for l in git('ls-tree','-r',source).decode().splitlines()};assert all(i['tracked']==(i['relative'] in tree) for i in inv);proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE);b=proc.communicate(('\n'.join(tree[i['relative']] for i in tracked)+'\n').encode())[0];off=0
for i in tracked:
 end=b.index(b'\n',off);h=b[off:end].decode().split();n=int(h[2]);r=b[end+1:end+1+n];off=end+n+2;assert h[0]==i['gitBlob']==tree[i['relative']] and len(r)==i['bytes'] and sha(r)==i['sha256']
assert off==len(b);cfg=json.load(open(p/'133-producer-hosted-correction-tsconfig.json'));assert cfg==json.loads(gzip.decompress(git('show',base+':docs/evidence/3613-real-handoff-producer/hosted-fixture-correction/133-producer-hosted-correction-tsconfig.json.gz')));assert git('show',source+':tsconfig.json')==git('show',base+':tsconfig.json')
root='/Users/masonallen/source/Clubhouse/.clubhouse/agents/lane-3613-p2-routes/node_modules/.cache/3613-p7w-remaining-consumers-work';assert len(cfg['files'])==3 and all(root+'/'+f.removeprefix('../../../') in actual for f in cfg['files']);lint=json.load(open(p/'155-fixture-teardown-lint-original.json'));assert len(lint)==1 and lint[0]['errorCount']==lint[0]['warningCount']==0
out['compiler']={'154Exit':0,'orderedInputs':3959,'trackedHashesVerifiedToSourceGit':2471,'dependencyHashesOwnerObservedAfterExecution':1488,'threeCompleteFixtures':cfg['files'],'atomicReadSeal':False};out['lint']={'155Exit':0,'completeFixtureFiles':1,'errors':0,'warnings':0};out['diagnosticBounds']=m['limits']
for f in ['test/fixtures','docs/evidence/3613-real-handoff-producer','docs/evidence/3613-native-handoff-ingress','docs/evidence/3613-reverse-handoff','docs/evidence/3613-handoff-reverse-sync']:
 assert git('rev-parse',base+':'+f)==git('rev-parse',source+':'+f)
changes=git('diff','--name-only',source,proof).decode().splitlines();assert changes and all(f.startswith(pre) for f in changes)
out['protectedHistoricalTreesEqual']=True;out['manifestSha256']=sha((p/'manifest.json').read_bytes());out['readmeSha256']=sha((p/'README.md').read_bytes());out['disposition']='APPROVE F1/F2 exact fixture successor for one ordinary same-PR new-head observation after guards; no hosted cause/fix/landing acceptance'
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='xml'},indent=2))
