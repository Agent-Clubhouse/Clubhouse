import pathlib,subprocess,json,gzip,hashlib,xml.etree.ElementTree as ET,collections,re
p=pathlib.Path(__file__).parent;ref='8d8e3d28fb48e13323002b3792d73d2e4743d713';head='219fca7759963de4c68a4ddf0159c6c7b1a97645';base='e2da738ce3db11a21c250333e7a80a1ffb8347c2';d='docs/evidence/3613-real-handoff-producer/fixture-owner-successor/';f='test/annex-v2/handoff-producer-admission.test.ts';git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();raw=git('show',ref+':'+d+'manifest.json');m=json.loads(raw)
assert len(m['archives'])==73
assert set(git('ls-tree','-r','--name-only',ref,d).decode().splitlines())=={d+a['file'] for a in m['archives']}|{d+'README.md',d+'manifest.json'}
for a in m['archives']:
 c=git('show',ref+':'+d+a['file']);b=gzip.decompress(c);assert len(c)==a['gzipBytes'] and sha(c)==a['gzipSha256'] and len(b)==a['bytes'] and sha(b)==a['sha256'] and b==(p/a['file'][:-3]).read_bytes()
assert git('diff','--name-only',base,head).decode().splitlines()==[f]
assert all(x.startswith(d) for x in git('diff','--name-only',head,ref).decode().splitlines())
assert git('rev-parse',head+':src').decode().strip()==m['srcTree']=='505ff0699b01779e52338e06a239d7cc15a6d2b1'
assert git('rev-parse',head+':'+f)==git('rev-parse',ref+':'+f)
assert git('show',head+':'+f)==(p/'fixture.test.ts').read_bytes()
assert sha((p/'168-full-design-report-original.md').read_bytes())=='a881e0fbc3fcd18ec5c35fb6b2e6d2a59117768fe86b1733437e6c89ecc81c37'
rows=[]
for r in m['runs']:
 name=r['prefix'];b=json.loads((p/(name+'-before.json')).read_text());a=json.loads((p/(name+'-after.json')).read_text());assert b['clean'] and a['clean'] and not b['status'] and not a['status'];assert b['head']==a['head']==r['head'] and b['tree']==a['tree']==r['tree'] and b['srcTree']==a['srcTree']==r['srcTree'];assert b['command']==a['command']==r['command'];assert b['files']==a['files'] and len(b['files'])==16
 for path,v in b['files'].items():
  if path.startswith('node_modules/'):
   data=(p/('bound-input-'+path.replace('/','__'))).read_bytes()
  else:data=git('show',r['head']+':'+path)
  assert len(data)==v['bytes'] and sha(data)==v['sha256']
 assert int((p/(name+'-exit.txt')).read_text().strip())==r['exit']==0
 log=(p/(name+'-original.log')).read_text();assert 'START lane-p2' in log and 'END lane-p2' in log
 item={'prefix':name,'head':r['head'],'matchingCleanPrePostInputs':16,'exit':0}
 if 'declarations' in r:
  xml=ET.parse(p/(name+'-original.xml'));cs=collections.Counter();names=[]
  for c in xml.iter('testcase'):
   fail=c.findall('failure')+c.findall('error');status='fail' if fail else 'skip' if c.find('skipped') is not None else 'pass';cs[status]+=1
   if status=='pass':names.append(c.get('name'))
  assert dict(cs)==r['counts'] and sum(cs.values())==r['declarations'];item.update(counts=dict(cs),declarations=r['declarations'],passedCases=names)
 elif 'diagnostics' in r:
  listed=[x.strip() for x in log.splitlines() if x.strip().startswith('/Users/') and re.search(r'\.(?:ts|tsx|cts|mts|js|mjs|json)$',x.strip())];assert len(listed)==r['orderedListFilesRows']==3959;assert not re.search(r'error TS\d+:',log);item['listFiles']=3959
 else:
  lint=json.loads((p/(name+'-original.json')).read_text());assert len(lint)==1 and lint[0]['errorCount']==0 and lint[0]['warningCount']==0;item['lintFiles']=1
 rows.append(item)
# Inventory is an after-execution observation, not a pre-execution dependency seal.
inv=json.loads((p/'174-input-inventory-observed-after-execution.json').read_text());assert isinstance(inv,list) and len(inv)==3959
log=(p/'174-owner-final-types-original.log').read_text();listed=[x.strip() for x in log.splitlines() if x.strip().startswith('/Users/') and re.search(r'\.(?:ts|tsx|cts|mts|js|mjs|json)$',x.strip())];assert listed==[x['path'] for x in inv] and [x['ordinal'] for x in inv]==list(range(3959));tracked=[x for x in inv if x['tracked']];assert len(tracked)==2471 and len(inv)-len(tracked)==1488
# Bind tracked blobs directly to exact source using one read-only batch, without loading dependencies.
proc=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
for x in tracked:
 proc.stdin.write((head+':'+x['relative']+'\n').encode());proc.stdin.flush();header=proc.stdout.readline().decode().strip().split();assert header[1]=='blob';data=proc.stdout.read(int(header[2]));assert proc.stdout.read(1)==b'\n';assert header[0]==x['gitBlob'] and len(data)==x['bytes'] and sha(data)==x['sha256']
proc.stdin.close();assert proc.wait()==0
for fixture in [f,'src/main/services/clubhouse-mcp/tools/handoff-tools.test.ts','src/main/services/prepare-handoff-skill.test.ts']:assert fixture in {x['relative'] for x in inv}
# Original164 copied byte-for-byte, never reexecuted.
oldref='e2da738ce3db11a21c250333e7a80a1ffb8347c2';oldd='docs/evidence/3613-real-handoff-producer/fixture-overlap-baseline/'
for suffix in ['after.json','before.json','exit.txt','original.log','original.xml']:
 name='164-overlap-original-red-'+suffix;assert (p/name).read_bytes()==gzip.decompress(git('show',oldref+':'+oldd+name+'.gz'))
x=ET.parse(p/'164-overlap-original-red-original.xml');cs=collections.Counter();nf=0
for c in x.iter('testcase'):
 fs=c.findall('failure')+c.findall('error');nf+=len(fs);cs['fail' if fs else 'skip' if c.find('skipped') is not None else 'pass']+=1
assert dict(cs)=={'fail':1,'skip':58} and nf==4
bridge=json.loads((p/'176-owner-source-bridges-original.json').read_text());assert bridge==m['sourceBridges'] and bridge['originalCallbacks']==33 and bridge['currentCallbacks']==40 and sum(x['normalizedAssertions'] for x in bridge['preserved'])==448
source=(p/'fixture.test.ts').read_text();callbacklines=[x for x in source.splitlines() if 'async (' in x and ('it(' in x or "'fences %s'" in x)];assert source.count('=> runFixtureBody(async () => {')==40
out={'evidence':ref,'evidenceTree':git('rev-parse',ref+'^{tree}').decode().strip(),'source':head,'sourceTree':m['sourceTree'],'srcTree':m['srcTree'],'fixtureBlob':git('rev-parse',head+':'+f).decode().strip(),'archivesVerified':73,'directoryFiles':75,'manifestSha256':sha(raw),'readmeSha256':sha((p/'README.md').read_bytes()),'runs':rows,'original164CopiedBytesEqual':True,'xmlCustodyRowsDistinctSources':196,'compilerObservedAfterExecution':{'orderedInputs':3959,'trackedBytesVerifiedToGit':2471,'dependencyObservationsNotReobservedByReviewer':1488,'threeCompleteFixturesIncluded':True,'preExecutionOrAtomicSeal':False},'staticBridge':{'originalPhysicalRegistrations':33,'currentWrappersIndependentlyCounted':40,'normalizedExpectCallTextsOwnerBridge':448,'wholeBodyOrByteBridge':False,'review':'direct relevant callback/helper/diff inspection, not runtime of50skips'},'finding':{'id':'F1','sourceDerivedNotReviewerExecution':True,'lines':'323-331; core287-295; caller174-179','description':'Hook invokes hold releases before core closes retiring, permitting synchronous reentrant caller admission.'},'reviewerProductExecution':False,'disposition':'BLOCK exact candidate pending narrow hook pre-release admission ordering correction; other reviewed source/evidence boundaries reusable with stated limits'}
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k not in ['runs','staticBridge']},indent=2));print('run summaries',[(x['prefix'],x.get('counts',x.get('listFiles',x.get('lintFiles')))) for x in rows])
