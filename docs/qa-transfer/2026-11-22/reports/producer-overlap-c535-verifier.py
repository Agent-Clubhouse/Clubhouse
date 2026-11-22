import pathlib,subprocess,json,gzip,hashlib,xml.etree.ElementTree as E,collections
p=pathlib.Path(__file__).parent;ref='e2da738ce3db11a21c250333e7a80a1ffb8347c2';base='76656abec9b5f9a0fb6f6cd12b74178efcbf7ae2';head='c535d031ef94617c2364e745a9765c91c2a31726';d='docs/evidence/3613-real-handoff-producer/fixture-overlap-baseline/';f='test/annex-v2/handoff-producer-admission.test.ts';git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();raw=git('show',ref+':'+d+'manifest.json');m=json.loads(raw);bdir=p/'baseline';bdir.mkdir(exist_ok=True);data={}
assert len(m['archives'])==42
assert set(git('ls-tree','-r','--name-only',ref,d).decode().splitlines())=={d+a['file'] for a in m['archives']}|{d+'README.md',d+'manifest.json'}
for a in m['archives']:
 c=git('show',ref+':'+d+a['file']);b=gzip.decompress(c);assert len(c)==a['gzipBytes'] and sha(c)==a['gzipSha256'] and len(b)==a['bytes'] and sha(b)==a['sha256'];data[a['file'][:-3]]=b;(bdir/a['file'][:-3]).write_bytes(b)
for name in ['README.md','manifest.json']:(bdir/name).write_bytes(git('show',ref+':'+d+name))
original=git('show',base+':'+f);source=git('show',head+':'+f);control=data['baseline-added-control.txt'];assert len(control)==2401 and len(control.splitlines())==47 and source.count(control)==1 and source.replace(control,b'',1)==original and len(original)==66098 and sha(original)==m['bridges']['completeOriginalFixture']['sha256'];assert original==data['source-'+base+'-fixture.test.ts'] and source==data['source-'+head+'-fixture.test.ts'];assert git('rev-parse',ref+':'+f)==git('rev-parse',head+':'+f)
assert git('diff','--name-only',base,head).decode().splitlines()==[f]
assert git('rev-parse',head+':src').decode().strip()==m['srcTree']
wrapper=data['original-owned-wrapper-and-cleanup.txt'];assert original.count(wrapper)==1 and source.count(wrapper)==1 and len(wrapper)==2781
before=json.loads(data['164-overlap-original-red-before.json']);after=json.loads(data['164-overlap-original-red-after.json']);assert before['clean'] and after['clean'] and not before['status'] and not after['status']
assert before['head']==after['head']==head and before['tree']==after['tree']==m['sourceTree'] and before['srcTree']==after['srcTree']==m['srcTree']
assert before['files']==after['files'] and len(before['files'])==16
for name,entry in before['files'].items():
 b=data['bound-input-'+name.replace('/','__')];assert len(b)==entry['bytes'] and sha(b)==entry['sha256']
 if not name.startswith('node_modules/'):
  assert b==git('show',head+':'+name)
log=data['164-overlap-original-red-original.log'].decode();assert 'START lane-p2' in log and 'END lane-p2' in log and '2026-11-22T22:50:27Z' in log and '2026-11-22T22:50:29Z' in log

xml=E.fromstring(data['164-overlap-original-red-original.xml']);counts=collections.Counter();cases=[]
for c in xml.iter('testcase'):
 fs=list(c.findall('failure'))+list(c.findall('error'));s='fail' if fs else 'skip' if c.find('skipped') is not None else 'pass';counts[s]+=1
 if fs:cases.append({'name':c.get('name'),'time':c.get('time'),'failureNodes':len(fs),'failures':[{'attributes':x.attrib,'text':x.text} for x in fs]})
assert dict(counts)=={'fail':1,'skip':58} and len(cases)==1 and cases[0]['failureNodes']==4
assert all(x['attributes']['type']=='AssertionError' for x in cases[0]['failures'])
assert data['164-overlap-original-red-exit.txt'].strip()==b'1'
assert b'keeps overlapping cleanup behind the original actual preparation drain' in control and b'callTool' in control and b'cleanupFixture()' in control
out={'ref':ref,'tree':git('rev-parse',ref+'^{tree}').decode().strip(),'source':head,'sourceTree':git('rev-parse',head+'^{tree}').decode().strip(),'srcTree':m['srcTree'],'archivesVerified':42,'directoryFiles':44,'manifestSha256':sha(raw),'readmeSha256':sha((bdir/'README.md').read_bytes()),'originalFixtureBlob':git('rev-parse',base+':'+f).decode().strip(),'originalFixtureBytes':len(original),'originalFixtureSha256':sha(original),'singleControlLines':47,'singleControlBytes':2401,'completeOriginalFixtureReconstructed':True,'ownedWrapperCleanupBytes':2781,'ownedWrapperCleanupUnchanged':True,'matchingCleanPrePostInputHashes':16,'all16ArchivedInputBytesVerified':True,'counts':dict(counts),'failureNodes':4,'failedCase':cases[0],'contract165Sha256':sha(data['165-overlap-minimal-hunk-contract.txt']),'additive167Sha256':sha(data['167-overlap-contract-refinement.txt']),'noReviewerProductExecution':True}
(p/'baseline-independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k!='failedCase'}))
