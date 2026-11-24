#!/usr/bin/env node
// Offline only. No subprocesses or test execution.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {activeTests,testEvidence} from './prompt-codec-behavior-verdict.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dir=path.join(root,'docs/ci-efficiency/behavior-value');
const raw=fs.readFileSync(path.join(dir,'results.json'),'utf8');
const r=JSON.parse(raw);
const redactionPath=path.join(dir,'redaction.json');
const redaction=fs.existsSync(redactionPath)?JSON.parse(fs.readFileSync(redactionPath,'utf8')):null;
const mutants=r.faults.map(f=>f.id), ids=['original','equivalent-control',...mutants];
const normalizeFile=file=>file.startsWith('src/') ? file : file.includes('/src/') ? 'src/'+file.split('/src/').at(-1) : file;
const testRows=row=>row.tests.map(t=>({...t,file:normalizeFile(t.file)}));
const original=r.runs.find(x=>x.id==='original'&&x.mode==='baseline'&&!x.omitted);
const baseline=activeTests(testRows(original)).filter(t=>t.file.endsWith('prompt-codec.test.ts'));
const consumer=testRows(r.runs.find(x=>x.id==='original'&&x.mode==='consumer'));
const initial=['behavior-value: preserves supported strong and emphasis semantics','behavior-value: maps every visible character boundary through cached syntax','behavior-value: chooses the earlier text position for an equally near source boundary'];
const refined=[...initial,'behavior-value: keeps fenced emphasis visibly literal and unmarked'];
const shipped=['behavior-value: preserves supported strong and emphasis semantics','behavior-value: maps visible selections to slash token and marked text','behavior-value: keeps fenced emphasis visibly literal and unmarked'];
const file='src/renderer/features/agents/chat/prompt-codec.test.ts';
const witness='src/renderer/features/agents/chat/behavior-witness.test.ts::public differential witnesses (observations only)';
const key=t=>`${t.file}::${t.identity}`;
const audit={schemaVersion:1,mode:'offline retained-case evidence only',provenance:{rawMilestoneCommit:'c92abd0b81547089fbe2b7ded914b98f90e63aca',rawMilestonePath:'docs/ci-efficiency/behavior-value/results.json',sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),rawMilestoneSha256:redaction?.files['results.json'].originalSha256||crypto.createHash('sha256').update(raw).digest('hex')},unknowns:['All 86 valid historical runs omit raw suite status/message, aggregate reporter counters and unhandled-error collection. Global suite/runtime integrity cannot be reconstructed. Future strict runner captures and requires this metadata.'],errors:[],runs:[]};
const check=(ok,msg)=>{if(!ok)audit.errors.push(msg);};
if(redaction)check(audit.provenance.sourceSha256===redaction.files['results.json'].sanitizedSha256,'sanitized receipt hash differs from redaction manifest');
check(baseline.length===55,'baseline count');check(consumer.length===10,'consumer count');check(r.runs.length===86,'run count');
for(const t of baseline) check(Object.values(r.groups).filter(ps=>ps.some(p=>t.identity.includes(p))).length===1,`group partition: ${t.identity}`);
for(const [index,row] of r.runs.entries()) {
 const phase=index<72?'initial':index<81?'experimental-integer-fence':'shipped';
 let names;
 if(row.mode==='consumer') names=consumer.map(key);
 else {
  names=baseline.filter(t=>!row.omitted||!r.groups[row.omitted].some(p=>t.identity.includes(p))).map(key);
  if(row.mode==='stronger') names.push(...(phase==='initial'?initial:phase==='experimental-integer-fence'?refined:shipped).map(n=>`${file}::${n}`));
  if(row.mode==='baseline'&&!row.omitted)names.push(witness);
 }
 const verdict=testEvidence(testRows(row),row.exitCode,names);
 const active=activeTests(testRows(row));
 check(row.activeCount===active.length,`active count ${index}`);
 check(row.codecCount===active.filter(t=>t.file===file).length,`codec count ${index}`);
 check(row.identityCheck===true,`original identity flag ${index}`);
 check(active.every(t=>Number.isFinite(t.durationMs)&&t.durationMs>=0),`duration ${index}`);
 check(verdict.outcome===row.outcome,`verdict mismatch/unknown ${index}: ${verdict.outcome}`);
 check(!(row.id==='original'||row.id==='equivalent-control')||verdict.outcome==='pass',`negative control ${index}`);
 audit.runs.push({index,phase,id:row.id,mode:row.mode,omitted:row.omitted,activeCount:active.length,outcome:verdict.outcome,namesCountsExitAndKnownAssertions:verdict.outcome!=='invalid',globalSuiteRuntimeIntegrity:'unknown-not-retained',failureReasons:verdict.reasons||[],diagnostic:verdict.reason});
}
for(const id of ids) {
 const rows=r.runs.filter(x=>x.id===id&&x.mode==='baseline');
 check(rows.length===6&&new Set(rows.map(x=>x.omitted)).size===6,`full/complements missing ${id}`);
 for(const group of Object.keys(r.groups))check(rows.some(x=>x.omitted===group),`omitted group missing ${id}/${group}`);
}
check(r.setupAttempts.length===2&&r.setupAttempts.every(x=>x.outcome==='invalid'&&x.activeCount===0),'two invalid setup receipts');
const baseKills=mutants.filter(id=>r.runs.find(x=>x.id===id&&x.mode==='baseline'&&!x.omitted).outcome==='assertion-kill');
const finalRuns=r.runs.slice(81);
const finalKills=finalRuns.filter(x=>x.outcome==='assertion-kill').map(x=>x.id);
check(JSON.stringify(baseKills)===JSON.stringify(['exact-gate','default-exact','dropped-marks','numbering']),'four baseline holds');
check(JSON.stringify(finalKills)===JSON.stringify(['cached-position','fence-literal']),'two shipped additions');
check(finalRuns.find(x=>x.id==='boundary-tie')?.outcome==='pass','tie survives shipped subset');
check(r.subprocesses===88&&r.executionMs<180000&&r.originalPreserved===true,'limits and source preservation');
audit.findings={baseKills,finalNewKills:finalKills,finalTie:'survives; fractional and integer exploratory direction assertions excluded',staleExperimentalOnly:['full numeric mapping array','fractional tie-direction assertion','integer tie-direction assertion'],subprocesses:r.subprocesses,elapsedMs:r.executionMs,strictGlobalAcceptance:'deferred: missing historical metadata'};
const csvCell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
const csv=(name,rows)=>fs.writeFileSync(path.join(dir,name),rows.map(row=>row.map(csvCell).join(',')).join('\n')+'\n');
function matrix(name,tests,select){
 const samples=Object.fromEntries(ids.map(id=>[id,select(id)]));
 const kills=Object.fromEntries(mutants.map(id=>[id,tests.filter(t=>samples[id]?.tests.find(s=>s.identity===t.identity)?.status==='failed').map(t=>t.identity)]));
 csv(name,[['test identity','original duration ms',...mutants.map(id=>`${id}: status @ duration ms`),'sampled killed mutants','sampled unique kills in this set'],...tests.map(t=>{
  const hits=mutants.filter(id=>kills[id].includes(t.identity));
  const duration=samples.original?.tests.find(s=>s.identity===t.identity)?.durationMs;
  return [t.identity,duration,...mutants.map(id=>{const sample=samples[id]?.tests.find(s=>s.identity===t.identity);return sample?`${sample.status==='failed'?'assertion-fail':sample.status} @ ${sample.durationMs}`:'not run in this phase';}),hits.join('; '),hits.filter(id=>kills[id].length===1).join('; ')];
 })]);
}
matrix('baseline-test-mutant.csv',baseline,id=>r.runs.find(x=>x.id===id&&x.mode==='baseline'&&!x.omitted));
matrix('shipped-additions-test-mutant.csv',shipped.map(identity=>({identity})),id=>finalRuns.find(x=>x.id===id));
matrix('consumer-test-mutant.csv',consumer,id=>r.runs.find(x=>x.id===id&&x.mode==='consumer'));
const timing=[['variant','omitted group','removed count','executed codec count','full wall ms (includes witness)','LOO wall ms','LOO minus full wall ms','removed group per-test duration sum in full ms','retained per-test duration sum in LOO ms']];
for(const id of ids){const full=r.runs.find(x=>x.id===id&&x.mode==='baseline'&&!x.omitted);for(const group of Object.keys(r.groups)){const loo=r.runs.find(x=>x.id===id&&x.omitted===group);const removed=testRows(full).filter(t=>t.file===file&&r.groups[group].some(p=>t.identity.includes(p)));timing.push([id,group,removed.length,loo.codecCount,full.elapsedMs,loo.elapsedMs,loo.elapsedMs-full.elapsedMs,removed.reduce((n,t)=>n+t.durationMs,0),activeTests(loo.tests).reduce((n,t)=>n+t.durationMs,0)]);}}
csv('group-runtime-loo.csv',timing);
fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify({errors:audit.errors,unknowns:audit.unknowns,findings:audit.findings},null,2));
if(audit.errors.length)process.exitCode=1;
