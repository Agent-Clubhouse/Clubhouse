import pathlib,json,subprocess,hashlib,gzip,re,collections,xml.etree.ElementTree as ET
p=pathlib.Path(__file__).parent;m=json.load(open(p/'manifest.json'));git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();source=m['source'];base=m['base'];proof='6fa27a5a7f7b497a779df831b008489741390658';pre='docs/evidence/3613-real-handoff-producer/hosted-fixture-correction/';paths=m['selectedFiles'];skill=paths[0];producer=paths[1]
assert git('rev-parse',source+'^{tree}').decode().strip()==m['sourceTree'];assert git('rev-parse',source+':src').decode().strip()==m['srcTree'];assert set(git('diff','--name-only',base,source).decode().splitlines())==set(paths) and len(paths)==2
out={'source':source,'sourceTree':m['sourceTree'],'srcTree':m['srcTree'],'proof':proof,'proofTree':git('rev-parse',proof+'^{tree}').decode().strip(),'changedFiles':paths}
for a in m['archives']:
 b=git('show',proof+':'+pre+a['file']);r=gzip.decompress(b);assert len(b)==a['gzipBytes'] and sha(b)==a['gzipSha256'] and len(r)==a['bytes'] and sha(r)==a['sha256'] and r==(p/a['file'].removesuffix('.gz')).read_bytes()
# All archived full fixture source variants and deltas match Git.
for f in p.glob('source-*.ts'):
 match=re.match(r'source-([a-f0-9]{40})-(.*)',f.name);ref,name=match.groups();path=skill if name=='prepare-handoff-skill.test.ts' else producer;assert f.read_bytes()==git('show',ref+':'+path)
for f in p.glob('delta-*.patch'):
 a,b=re.match(r'delta-([a-f0-9]{40})-([a-f0-9]{40})\.patch',f.name).groups();assert f.read_bytes()==git('diff',a,b,'--',*paths)
# All production files remain original across run heads; only a src fixture changes inside src.
for run in m['runs']:
 assert set(git('diff','--name-only',base,run['head'],'--','src').decode().splitlines()).issubset({skill})
# Existing assertion/deadline bodies remain byteequal (new tests removed from successor for this comparison).
old=git('show',base+':'+producer).decode();new=git('show',source+':'+producer).decode();anchor="  it('keeps current sender authority, source bytes and durable binding through a held history queue'";assert old[old.index(anchor):]==new[new.index(anchor):]
oldskill=git('show',base+':'+skill).decode();newskill=git('show',source+':'+skill).decode();start="  it('refuses the same prepared offer when its original agreement scope is bypassed'";end="  it('tells a too-big refusal apart from a secret finding, and a dirty branch from both'";withoutnew=newskill[:newskill.index(start)]+newskill[newskill.index(end):];anchor="describe('the prepare-handoff skill (#3344)', () => {";assert oldskill[oldskill.index(anchor):]==withoutnew[withoutnew.index(anchor):]
# Purely erased source declaration bridge; do not execute TS/Vitest again.
a0='a0b564ed499acc9dff2121c12849ee237401f20b';dd='dd508e39270d6d55bfd2c62eee5d3a974d5ea220';erased=newskill.replace("import type { DurableAgentConfig } from '../../shared/types';\n",'').replace('getSatellite: (): undefined =>','getSatellite: () =>').replace(': (() => void) =>', ' =>').replace('getAllBindings: (): [] =>','getAllBindings: () =>').replace('getBindingsForAgent: (): [] =>','getBindingsForAgent: () =>').replace('const row: DurableAgentConfig =','const row =')
assert erased==git('show',a0+':'+skill).decode()==git('show',dd+':'+skill).decode();assert git('show',dd+':'+producer)==git('show',source+':'+producer)
bridge=json.load(open(p/'fixture-type-only-emission-bridge.json'));assert bridge==m['bridge'] and bridge['oldHead']==a0 and bridge['newHead']==source and bridge['identical'] is True;out['typeBridge']={'erasedSourceExactA0AndDd':True,'finalProducerBytesEqualDd140':True,'ownerTranspileReceipt':bridge,'reviewerDidNotExecuteTranspileOrCompiler':True,'notVitestTransformIdentity':True}
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
 else:
  if 'diagnostics' in run:assert len(re.findall(r'error TS\d+:',log))==len(run['diagnostics'])
assert len(xml)==5 and total==120;out['receipts']=receipts;out['xml']=xml;out['xmlRows']=total;out['archiveCount']=len(m['archives'])
inv=json.load(open(p/'143-owner-observed-after-execution-input-inventory.json'));log=(p/'143-hosted-correction-types-original.log').read_text();actual=[l for l in log.splitlines() if l.startswith('/')];assert len(actual)==len(inv)==3959 and actual==[x['path'] for x in inv] and not re.search(r'error TS\d+:',log)
tracked=[i for i in inv if i['tracked']];assert len(tracked)==2471;tree={l.split('\t')[1]:l.split('\t')[0].split()[2] for l in git('ls-tree','-r',source).decode().splitlines()};proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE);b=proc.communicate(('\n'.join(tree[i['relative']] for i in tracked)+'\n').encode())[0];off=0
for i in tracked:
 end=b.index(b'\n',off);h=b[off:end].decode().split();n=int(h[2]);r=b[end+1:end+1+n];off=end+n+2;assert h[0]==i['gitBlob']==tree[i['relative']] and len(r)==i['bytes'] and sha(r)==i['sha256']
assert off==len(b);cfg=json.load(open(p/'133-producer-hosted-correction-tsconfig.json'));assert cfg['extends']=='../../../tsconfig.json' and cfg['compilerOptions']=={'noEmit':True} and cfg['include']==['../../../src/**/*'] and len(cfg['files'])==3;assert set(cfg)=={'extends','compilerOptions','include','files'};assert git('show',source+':tsconfig.json')==git('show',base+':tsconfig.json')
root='/Users/masonallen/source/Clubhouse/.clubhouse/agents/lane-3613-p2-routes/node_modules/.cache/3613-p7w-remaining-consumers-work';assert all(root+'/'+f.removeprefix('../../../') in actual for f in cfg['files']);lint=json.load(open(p/'144-hosted-correction-lint-original.json'));assert len(lint)==2 and all(x['errorCount']==x['warningCount']==0 for x in lint)
out['compiler']={'143Exit':0,'orderedListFilesInputs':3959,'trackedHashesVerifiedToSourceGit':2471,'dependencyHashesOwnerObservedAfterExecution':1488,'threeCompleteFixtures':cfg['files'],'atomicSeal':False};out['lint']={'144Exit':0,'files':2,'errors':0,'warnings':0};out['oldAssertionsAndDeadlinesPreserved']=True;out['onlyTwoFixturesProductionUnchanged']=True
for f in ['test/fixtures','docs/evidence/3613-real-handoff-producer','docs/evidence/3613-native-handoff-ingress','docs/evidence/3613-reverse-handoff','docs/evidence/3613-handoff-reverse-sync']:
 assert git('rev-parse',base+':'+f)==git('rev-parse',source+':'+f)
# Proof adds hosted-fixture-correction evidence only; source's original evidence remains unchanged.
changes=git('diff','--name-only',source,proof).decode().splitlines();assert changes and all(f.startswith(pre) for f in changes)
out['protectedSourceEvidenceTreesEqual']=True;out['manifestSha256']=sha((p/'manifest.json').read_bytes());out['readmeSha256']=sha((p/'README.md').read_bytes());out['disposition']='BLOCK F1 rejection-shortcircuited fixture drain and F2 uncontained diagnostics; no production acceptance reopening'
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='xml'},indent=2))
