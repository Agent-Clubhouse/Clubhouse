from pathlib import Path
import subprocess,json,hashlib
r=Path('/Users/masonallen/source/Clubhouse/.clubhouse/qa-reports');head='017f7ec9dae90361f09c6c5c8858b3534c95a281';parent='67d8782abdcd97bfaa19b88d2e7809e84a3d3358';tree='aae189a702f38fb73b337a10e9be48b1600a2727';p='3733-017f7ec9d'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==head
builder=(r/'3733-67d8782ab-proof-builder.py').read_text().replace("assert head=='67d8782abdcd97bfaa19b88d2e7809e84a3d3358'",f"assert head=='{head}'").replace("prefix='3733-67d8782ab'",f"prefix='{p}'")
exec(compile(builder,'retained-builder','exec'))
ctrl=json.loads((r/f'{p}-controls.json').read_text());S='src/main/services/'
def add(name,file,changes,pattern,limit):
 source=Path(file).read_text()
 for old,new in changes:assert source.count(old)==1,(name,old,source.count(old));source=source.replace(old,new)
 ctrl.append(dict(name=name,file=file,changes=changes,tests=[file.replace('.ts','.test.ts')],pattern=pattern,evidenceLimit=limit))
line="    const displayRunId = runtime?.kind === 'chat' ? runtime.getDisplayRunId?.() ?? null : null;\n"
for title,file in [('main',S+'remote-agent-details.ts'),('quick',S+'remote-quick-details.ts')]:
 add('red-'+title+'-drop-display-final-fence',file,[[" || (runtime.getDisplayRunId?.() ?? null) !== displayRunId",'']],'admitted.*Details display generation','Same-object/registration/app/native hard prestates plus early/late generation changes modeled. Stable/unsupported and revoked403 remain independent. No live/provider-payload disclosure claim.')
 needle="    const settingsRead = await readRemoteAgentSettings(agentId, authorized, { admittedTarget: target, admittedProvider: providerRead, receipts: settingsReceipts });\n" if title=='main' else "    await read('connections', (c) => {\n"
 inserted=needle+line if title=='main' else line+needle
 add('red-'+title+'-capture-display-after-first-await',file,[[line,''],[needle,inserted]],'early-reopen','Generation changed in the first modeled settings/template await; source/target primary evidence real where applicable. Exact placement/order discrimination, not latency or real runtime proof.')
(r/f'{p}-controls.json').write_text(json.dumps(ctrl,indent=2)+'\n')
cfg=json.loads((r/f'{p}-configuration.json').read_text());cfg['green'].append(S+'remote-quick-details.test.ts');(r/f'{p}-configuration.json').write_text(json.dumps(cfg,indent=2)+'\n')
get=lambda *a:subprocess.check_output(['git',*a]);paths=get('diff','--name-only',parent,head).decode().splitlines();assert set(paths)=={S+'remote-agent-details.ts',S+'remote-quick-details.ts',S+'remote-agent-details.test.ts',S+'remote-quick-details.test.ts','docs/implementation-notes/3733-generation-correction.md'}
ident={}
for file in [S+'remote-agent-details.ts',S+'remote-quick-details.ts']:
 b=get('show',parent+':'+file).decode();n=get('show',head+':'+file).decode();assert n.replace(line,'').replace(" || (runtime.getDisplayRunId?.() ?? null) !== displayRunId",'')==b
 ident[file]={'parentBlob':get('rev-parse',parent+':'+file).decode().strip(),'headBlob':get('rev-parse',head+':'+file).decode().strip(),'equalAfterRemovingOnlyCapturedGenerationAndFinalComparison':True}
for file in [S+'remote-agent-details.test.ts',S+'remote-quick-details.test.ts']:assert get('show',head+':'+file).startswith(get('show',parent+':'+file))
def entries(ref):return {l.split('\t',1)[1]:l.split('\t',1)[0] for l in get('ls-tree','-r',ref).decode().splitlines()}
b,n=entries(parent),entries(head);assert all(b.get(f)==v for f,v in n.items() if f not in paths);assert all(n.get(f)==v for f,v in b.items() if f not in paths)
(r/f'{p}-generation-identities.json').write_text(json.dumps({'head':head,'tree':tree,'parent':parent,'onlyDeltaPaths':paths,'entireOtherTreeEntriesEqual':True,'productionMinusTwoGuardAdditions':ident,'originalTestsAreUnchangedPrefixes':True,'coldSuccessorExcluded':True},indent=2)+'\n')
(r/f'{p}-generation-only.patch').write_bytes(get('diff','--binary',parent,head))
scope=json.loads((r/f'{p}-scope.json').read_text());scope.update({'scope':'Frozen67 selected Connections paging/registered-source consumer + isolated normal/Quick Details generation fence. EXCLUDES cold tool/source and Quick-paging WIP. No root/fullparity/PR acceptance.','generation':'Capture optional getDisplayRunId before first await, compare in existing final runtime fence; no DTO field/new authority.10 new stable/unsupported/early/late/revoked-reopen controls with same object/registration/app/native. Runtime/await callbacks modeled; primary/project fixtures actual.','resolverHistory':'Fresh generation-correction cwd failed bare tls import with zero tests; unchanged67 overlay in same cwd failed identically, all modified bytes restored. Exact immutable017 source passed10generation controls in pre-existing connections-complete cwd with same compatible dependencies and no production/dependency/cache/config workaround. Mechanism unresolved; no blanket infrastructure attribution. Failed logs CURRENT-linked only except controlled overlay hash receipt.','baseline':'Observed test-only48 on production9a9 Quick/tool WIP:2FAIL181SKIP, NOT executed67. Original3-artifact log/patch/result manifest included, no sealed aggregate-wrapper claim. This successor mutants additionally discriminate exact017 derived67.','remaining':'All cold Canvas/group/tool/user/helper-parent/Quick paging and full eligibility/navigation/other finite matrix remain outside THIS isolated source. Main/Quick generation correction does not transfer broader cold branch acceptance.'})
(r/f'{p}-scope.json').write_text(json.dumps(scope,indent=2)+'\n')
print('CONTROLS',len(ctrl),'SOURCE',head,tree)
