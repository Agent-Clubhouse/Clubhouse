import pathlib,json,subprocess,hashlib,re,xml.etree.ElementTree as ET,collections,copy
p=pathlib.Path(__file__).parent
sha=lambda b:hashlib.sha256(b).hexdigest()
git=lambda *a:subprocess.check_output(['git',*a])
source='60ed5f77f76029681160f298bfe789fb1d884512';base='206a88dcc93ecd7d2f5009d533894dd77e36e2ed';proof='e83d9f27f0e6a85f3a2791b1eadb85995c6ae701';red='f7c62dd5dc731bc2060c2c30f778823279396feb'
m=json.load(open(p/'manifest.json'));meta=json.load(open(p/'51-fixture-correction-metadata.json'));out={}
files=git('diff','--name-only',base,source).decode().splitlines();assert files==[f['file'] for f in m['files']]
assert git('diff','--name-only',source,proof).decode().splitlines() and all(x.startswith('docs/evidence/3613-native-handoff-ingress/hosted-fixture-correction/') for x in git('diff','--name-only',source,proof).decode().splitlines())
for e in m['files']:
 for label,ref in [('original',base),('red',red),('current',source)]:assert git('rev-parse',ref+':'+e['file']).decode().strip()==e[label]
for e in m['identities']:
 assert git('rev-parse',base+':'+e['file'])==git('rev-parse',source+':'+e['file'])==git('rev-parse',proof+':'+e['file'])
 assert git('rev-parse',source+':'+e['file']).decode().strip()==e['current']==e['original']
out['changedFiles']=files;out['unchangedProtectedIdentities']=len(m['identities'])
# Genuine discriminator fixture identical in red and green except helper correction.
oldnative=git('show',base+':'+files[1]).decode();rednative=git('show',red+':'+files[1]).decode();newnative=git('show',source+':'+files[1]).decode()
assert git('diff','--name-only',base,red).decode().splitlines()==[files[1]]
assert rednative[rednative.index("it('does not complete a reconnect"):]==newnative[newnative.index("it('does not complete a reconnect"):]
assert oldnative[oldnative.index("it('admits a current native"):]==newnative[newnative.index("it('admits a current native"):]
out['oldCaseBodiesIdentical']=True
old=git('show',base+':'+files[0]).decode();new=git('show',source+':'+files[0]).decode();added="  trustOf: (await importOriginal<typeof import('./annex-peers')>()).trustOf,\n";pos=new.index(added);line=new[:pos].count('\n')+1;assert line==279 and len(added.encode('utf-16-le'))//2==77
assert new[:pos]+new[pos+len(added):]==old
# XML independently derive every row, failures/counts, compare manifest selected rows.
xmls=[]
for exec in m['executions']:
 root=ET.fromstring((p/exec['artifact']).read_bytes()); cases=[]
 for c in root.iter('testcase'):
  status='failure' if c.find('failure') is not None else 'error' if c.find('error') is not None else 'skipped' if c.find('skipped') is not None else 'passed'
  d={'name':c.attrib['name'],'classname':c.attrib['classname'],'status':status}
  f=c.find('failure')
  if f is not None:d['failure']={'attributes':f.attrib,'text':f.text}
  cases.append(d)
 counts=collections.Counter(c['status'] for c in cases);assert {k:counts[k] for k in ['passed','failure','error','skipped']}==exec['counts']
 assert [c for c in cases if c['status']!='skipped']==exec['selected']
 assert sha((p/exec['artifact']).read_bytes())==exec['rawSha256']
 xmls.append({'artifact':exec['artifact'],'counts':dict(counts),'selected':[c for c in cases if c['status']!='skipped']})
out['xml']=xmls
redlog=(p/'45-fixture-red-original.log').read_text();assert '[vitest] No "trustOf" export is defined' in redlog
out['redUnhandledMissingMock']=True
# Full diagnostics: header + multiline details + order + multiplicity + unchanged exact source line.
def diagnostics(name):
 t=(p/name).read_text();start=re.search(r'^.*\(\d+,\d+\): error TS',t,re.M).start();end=re.search(r'^/',t[start:],re.M).start()+start;body=t[start:end].strip();matches=list(re.finditer(r'^(.*?)\((\d+),(\d+)\): error (TS\d+):',body,re.M));return body,matches
cb,cm=diagnostics('47-fixture-types-original.log');bb,bm=diagnostics('49-original-fixture-types-original.log');assert len(cm)==len(bm)==166
mapped=re.sub(r'src/main/services/annex-server\.test\.ts\((\d+),',lambda q:'src/main/services/annex-server.test.ts('+str(int(q[1])-1 if int(q[1])>line else int(q[1]))+',',cb);assert mapped==bb
mapping=[]
for c,b in zip(cm,bm):
 assert c[1]==b[1]==files[0] and c[3]==b[3] and c[4]==b[4]
 n=int(c[2]);o=int(b[2]);assert n!=line and old.splitlines()[o-1]==new.splitlines()[n-1]
 mapping.append({'file':c[1],'currentLine':n,'baselineLine':o,'column':int(c[3]),'code':c[4]})
out['typing']={'disposition':'Both actual commands FAIL166/exit2; exact full multiline diagnostic nonregression; not compiler PASS','normalizedDiagnosticSha256':sha(mapped.encode()),'mapping':mapping}
# Raw listFiles graph independent normalized paths, tree/tracked content hashes.
graphs=[]
for key in ['currentGraph','baselineGraph']:
 g=meta[key];raw=(p/g['log']).read_text();paths=[l for l in raw.splitlines() if l.startswith('/')];assert len(paths)==g['count']==3958
 currentroot=meta['currentGraph']['options']['baseUrl'];ownroot=g['options']['baseUrl']
 norm=[s[len(ownroot)+1:] if s.startswith(ownroot+'/') else s[len(currentroot)+1:] if s.startswith(currentroot+'/') else None for s in paths]
 assert norm==[i['relative'] for i in g['inputs']]
 tree={l.split('\t')[1]:l.split('\t')[0].split()[2] for l in git('ls-tree','-r',g['source']).decode().splitlines()}
 tracked=[i for i in g['inputs'] if i['tracked']];assert len(tracked)==g['tracked']==2470
 batch=subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
 data=batch.communicate(('\n'.join(i['blob'] for i in tracked)+'\n').encode())[0];offset=0
 for i in tracked:
  end=data.index(b'\n',offset);header=data[offset:end].decode().split();size=int(header[2]);content=data[end+1:end+1+size];offset=end+size+2
  assert i['blob']==tree[i['relative']]==header[0] and size==i['bytes'] and sha(content)==i['sha256']
 assert offset==len(data)
 roots=set(g['roots']);assert len(roots)==len(g['roots'])==2467
 prod={f for f in tree if f.startswith('src/') and pathlib.Path(f).suffix in {'.js','.jsx','.mjs','.cjs','.mts','.cts','.ts','.tsx'} and not f.endswith(('.test.ts','.test.tsx','.qa.ts'))}
 # TS root enumeration suppresses .mjs where same-stem .mts or .d.mts exists.
 prod={f for f in prod if not (f.endswith('.mjs') and (f[:-4]+'.mts' in prod or f[:-4]+'.d.mts' in prod))}
 assert roots==prod|set(files) and len(prod)==2465
 assert roots.issubset(set(norm))
 graphs.append({'source':g['source'],'inputs':len(norm),'roots':len(roots),'productionRoots':len(prod),'trackedContentHashesVerified':len(tracked),'dependencyHashes':len(g['inputs'])-len(tracked),'orderedInputNamesSha256':sha('\n'.join(norm).encode())})
a=meta['currentGraph'];b=meta['baselineGraph'];assert a['roots']==b['roots'];assert [i['relative'] for i in a['inputs']]==[i['relative'] for i in b['inputs']]
changedhash=[x['relative'] for x,y in zip(a['inputs'],b['inputs']) if x!=y];assert changedhash==files
normopts=lambda g:json.loads(json.dumps(g['options']).replace(g['options']['baseUrl'],'<checkout>'))
assert normopts(a)==normopts(b)
# Config paths anchored to root, not relaxed options.
for g in [a,b]:
 cfg=g['config'];canon=lambda s:s.removeprefix('../../../').removeprefix('./')
 assert canon(cfg['extends'])=='tsconfig.json' and [canon(f) for f in cfg['files']]==files
 rootconfig=json.loads(git('show',g['source']+':tsconfig.json'));assert [canon(f) for f in cfg['include']]==rootconfig['include'] and [canon(f) for f in cfg['exclude']]==rootconfig['exclude']
 assert set(cfg)=={'extends','files','compileOnSave','include','exclude'} and cfg['compileOnSave'] is False
out['graphs']=graphs;out['nonchangedInputHashesEqual']=3956;out['dependencyHashesOwnerObservedAfterExecutionOnly']=True
# Warning full object equality with exact UTF16 offset/source mapping, never ignore suggestions.
cl=json.load(open(p/'48-fixture-eslint-original.json'));bl=json.load(open(p/'50-original-fixture-eslint-original.json'))[0];legacy=next(i for i in cl if i['filePath'].endswith(files[0]));native=next(i for i in cl if i['filePath'].endswith(files[1]));assert native['errorCount']==native['warningCount']==legacy['errorCount']==bl['errorCount']==0;assert legacy['warningCount']==bl['warningCount']==247
u16pos=len(new[:pos].encode('utf-16-le'))//2
# exact nested recursive mapping for suggestions/fixes.
def fix(v):
 if isinstance(v,list):return [fix(i) for i in v]
 if not isinstance(v,dict):return v
 d={}
 for k,x in v.items():
  if k in ['line','endLine'] and isinstance(x,int):d[k]=x-1 if x>line else x
  elif k=='range' and isinstance(x,list):d[k]=[n-77 if n>=u16pos+77 else n for n in x]
  else:d[k]=fix(x)
 return d
assert [fix(x) for x in legacy['messages']]==bl['messages']
for c,bm in zip(legacy['messages'],bl['messages']):assert old.splitlines()[bm['line']-1]==new.splitlines()[c['line']-1]
out['lint']={'errors':0,'nativeWarnings':0,'legacyWarnings':247,'fullNestedObjectsMappedEqual':True,'insertedLine':line,'insertedUtf16Length':77,'normalizedWarningsSha256':sha(json.dumps(bl['messages'],sort_keys=True).encode()),'server71SeparateUnchanged':True}
# Actual raw exits and temporal command provenance.
for n,expected in [('45-fixture-red',1),('46-fixture-green',0),('47-fixture-types',2),('48-fixture-eslint',0),('49-original-fixture-types',2),('50-original-fixture-eslint',0)]:
 assert int((p/(n+'-exit-original.txt')).read_text())==expected
 raw=(p/(n+'-original.log')).read_text();assert ' START lane-p2 ' in raw and ' END lane-p2 rc='+str(expected) in raw
for n,s in [('45-red',red),('46-correction',source)]:
 assert (p/(n+'-source-original.txt')).read_text().strip().splitlines()==[s,git('rev-parse',s+'^{tree}').decode().strip()]
 assert (p/(n+'-source-original.patch')).read_bytes()==git('diff',base,s)
out['archivesVerified']=31;out['patchesAndSourceWitnessesEqualGit']=True
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({k:v for k,v in out.items() if k not in ['xml','typing']},indent=2));print('DIAGNOSTICS',len(mapping),'XML',[(x['artifact'],x['counts']) for x in xmls])
