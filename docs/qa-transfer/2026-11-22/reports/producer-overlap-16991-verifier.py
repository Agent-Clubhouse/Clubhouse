import pathlib,json,subprocess,hashlib,gzip,xml.etree.ElementTree as ET,collections,re,zipfile
p=pathlib.Path(__file__).parent;m=json.load(open(p/'manifest.json'));git=lambda *a:subprocess.check_output(['git',*a]);sha=lambda b:hashlib.sha256(b).hexdigest();ref='16991dca76a7a6117a3c7e26232ecae5b86d89d0';head='76656abec9b5f9a0fb6f6cd12b74178efcbf7ae2';prefix='docs/evidence/3613-real-handoff-producer/hosted-failure-45075711451/'
assert len(m['archives'])==68 and len(git('ls-tree','-r','--name-only',ref,prefix).decode().splitlines())==70
for a in m['archives']:
 b=git('show',ref+':'+prefix+a['file']);r=gzip.decompress(b);assert len(b)==a['gzipBytes'] and sha(b)==a['gzipSha256'] and len(r)==a['bytes'] and sha(r)==a['sha256'] and r==(p/a['file'].removesuffix('.gz')).read_bytes()
assert all(f.startswith(prefix) for f in git('diff','--name-only',head,ref).decode().splitlines());assert git('rev-parse',ref+':src')==git('rev-parse',head+':src');sourcepath='test/annex-v2/handoff-producer-admission.test.ts';source=git('show',head+':'+sourcepath);assert source==(p/'handoff-producer-admission.test.ts').read_bytes();assert git('rev-parse',head+':'+sourcepath).decode().strip()=='b455b81fd8dc3561df4ddedec77eadf1dc193cff'
logarchive=next(a for a in m['archives'] if a['sha256']==m['originalLog']['sha256']);log=(p/logarchive['file'].removesuffix('.gz')).read_text();ls=log.splitlines()
for c in m['checkout']:
 assert c['sha']=='f2a25a9272bd1bc0b832393731525e354aba7144' and c['sha'] in ls[c['resultLine']-1] and 'git' in ls[c['commandLine']-1].lower() and c['job'] in ls[c['resultLine']-1]
assert len(m['checkout'])==33 and not m['missingFailedJobCheckout'];assert m['jobCounts']=={'success':31,'skipped':4,'failure':2}
# Full archived JUnit counts and exact-family attribution; no broad substring family count.
xmlsummary=[];selected=[];total=0
for record in m['junit']:
 a=next(a for a in m['archives'] if a['originalPath']==record['file']);assert a['sha256']==record['sha256'];path=p/a['file'].removesuffix('.gz');counts=collections.Counter();families=collections.defaultdict(lambda:{'cases':0,'counts':collections.Counter(),'failureNodes':0})
 for _,c in ET.iterparse(path,events=['end']):
  if c.tag!='testcase':continue
  failures=[x for x in c if x.tag in ['failure','error']];status='fail' if failures else 'skip' if c.find('skipped') is not None else 'pass';counts[status]+=1;cls=c.get('classname','').replace('\\','/');v=families[cls];v['cases']+=1;v['counts'][status]+=1;v['failureNodes']+=len(failures)
  if cls==sourcepath and ('original caller rejection (1 failures)' in c.get('name','') or 'original caller rejection (9 failures)' in c.get('name','')):
   selected.append({'archive':a['file'],'name':c.get('name'),'classname':cls,'time':c.get('time'),'status':status,'failures':[{'tag':f.tag,'attributes':f.attrib,'text':f.text} for f in failures]})
  c.clear()
 assert dict(counts)==record['counts'] and sum(counts.values())==record['rows'];total+=record['rows'];xmlsummary.append({'archive':a['file'],'counts':dict(counts),'rows':record['rows']})
 attribution=next((x for x in m['exactUnitAttribution']['artifacts'] if x['file']==record['file']),None)
 if attribution:
  for group in attribution['groups'].values():
   f=families[group['sourcePath']];assert f['cases']==group['cases'] and dict(f['counts'])==group['counts'] and f['failureNodes']==group['failureNodes']
assert total==73255
windows=[x for x in selected if x['archive'].startswith('033-')];assert len(windows)==2;one=next(x for x in windows if '(1 failures)' in x['name']);nine=next(x for x in windows if '(9 failures)' in x['name']);onebody='\n'.join(x['text'] or '' for x in one['failures']);ninebody='\n'.join(x['text'] or '' for x in nine['failures']);assert ':329:53' in ninebody and 'if (count === 1)' in source.decode().splitlines()[328];assert 'Original fixture caller rejection 0.' in ninebody and 'EBUSY' in ninebody and 'handoff-producer-admission-lRnu4C' in ninebody and 'annex-identity.json' in ninebody;assert 'handoff-producer-admission-vpmoqm' in onebody
# Trace/container/step observations remain separate from PDF underlying cause.
chat=[]
for zname,ctxname in [('056-trace.zip','054-error-context.md'),('060-trace.zip','058-error-context.md')]:
 raw=(p/zname).read_bytes();z=zipfile.ZipFile(p/zname);rows=[json.loads(l) for l in z.read('test.trace').decode().splitlines()];context=(p/ctxname).read_text();assert "Couldn't read this PDF." in context and 'dialog "File preview"' in context and 'report.pdf (Read-only)' in context
 failed=[x for x in rows if x.get('type')=='after' and x.get('error')];assert len(failed)==1 and 'Page 1 of 2' in failed[0]['error']['message'] and '20000ms' in failed[0]['error']['message'];before={x['callId']:x for x in rows if x.get('type')=='before'};error=failed[0];matching=before[error['callId']];assert matching['stack'][0]['line']==205
 view=next(x for x in before.values() if x.get('subtitle')=="getByTestId('local-file-preview')" and x.get('stack',[{}])[0].get('line')==203);viewafter=next(x for x in rows if x.get('type')=='after' and x['callId']==view['callId']);assert not viewafter.get('error')
 chat.append({'traceArchive':zname,'bytes':len(raw),'sha256':sha(raw),'zipEntries':z.namelist(),'context':ctxname,'contextSha256':sha((p/ctxname).read_bytes()),'previewVisibleBeforeCanvasFailure':True,'pdfErrorStateObserved':"Couldn't read this PDF.",'failureStepLine':205,'callerLine':222,'assertionWaitMs':round(error['endTime']-matching['startTime'],3),'underlyingLoaderOrOpenExceptionCaptured':False})
# Minimal Chat static anchor, without implementation review.
pdf='src/renderer/features/agents/chat/rich/PdfPreview.tsx';pdfbytes=git('show',head+':'+pdf);assert b'loadPdfDocument().then(({ openPdf }) => openPdf(data)).then(' in pdfbytes and b"Couldn't read this PDF." in pdfbytes
changed=git('diff','--name-only','50c474b48f57e0256661244bd29b9343ec112bc4',head,'--','e2e','src/renderer','package.json','package-lock.json','vitest.config.ts','playwright.config.ts','.github/workflows').decode().splitlines();assert not changed
out={'evidence':ref,'tree':git('rev-parse',ref+'^{tree}').decode().strip(),'source':head,'sourceTree':m['sourceTree'],'srcTree':m['srcTree'],'archivesVerified':68,'directoryFiles':70,'checkoutWitnessesVerifiedInRawLog':33,'syntheticMerge':'f2a25a9272bd1bc0b832393731525e354aba7144','syntheticMergeTreeRemoteReadback':'0526a2a05866a683981805b546365aaf3b98af69','jobCounts':m['jobCounts'],'junit':xmlsummary,'xmlRows':total,'exactFamilyLedgerIndependentlyChecked':True,'originalCount1Count9':windows,'chat':chat,'chatSourceAnchor':{'path':pdf,'blob':git('rev-parse',head+':'+pdf).decode().strip(),'sha256':sha(pdfbytes),'lines':'21-31 loader/open rejection; render rejection has separate wording37-41'},'unchangedChatConfigPathsOnlyNotCausalityProof':True,'ownerHandoffSha256':sha((p/'owner-handoff.md').read_bytes()),'manifestSha256':sha((p/'manifest.json').read_bytes()),'readmeSha256':sha((p/'README.md').read_bytes()),'reviewerExecution':'read-only source/artifact analysis; no product/test/compiler/lint/CI','disposition':'bounded fixture owner/coalescing+body completion design ready with explicit error acknowledgment ordering; current hosted producer and Chat failures unwaived; no unseen implementation approval'}
(p/'independent-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({k:v for k,v in out.items() if k not in ['originalCount1Count9','chat']},indent=2))
