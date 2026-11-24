#!/usr/bin/env node
// Local experiment. Production mutations exist only in an automatically removed sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'docs/ci-efficiency/behavior-value');
const rel = 'src/renderer/features/agents/chat';
const original = fs.readFileSync(path.join(root, rel, 'prompt-codec.ts'), 'utf8');
const tests = fs.readFileSync(path.join(root, rel, 'prompt-codec.test.ts'), 'utf8');
const baselineTests = tests.split('// Behavior-value focused assertions.')[0];
const stronger = tests.slice(baselineTests.length);
if (!stronger) throw new Error('Focused assertion marker missing');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const groups = {
  preservation: ['is stable for subset source', 'preserves non-subset bytes', 'preserves edited source', 'leaves four-space', 'keeps paths, URLs'],
  structure: ['creates only schema-supported', 'normalizes numbered', 'uses parent marker widths', 'property: normalized non-crossing'],
  exact: ['keeps irregular numbering', 'restores pasted text exactly'],
  marks: ['property: arbitrary crossing', 'keeps targeted crossing', 'drops intraword italic'],
  mapping: ['maps slash-token offsets'],
};
const faults = [
  ['exact-gate', 'if (exact && serializePrompt', 'if (false && serializePrompt'],
  ['default-exact', '{ exact = false }', '{ exact = true }'],
  ['dropped-marks', 'nodes.push(promptSchema.text(text, marks));', 'nodes.push(promptSchema.text(text));'],
  ['cached-position', 'positions[pos + 1 + i] = base + offset;', 'positions[pos + 1 + i] = base + offset + 1;'],
  ['boundary-tie', 'if (delta < distance)', 'if (delta <= distance)'],
  ['numbering', '${number++}. ', '${++number}. '],
  ['fence-literal', 'const literal = !!fence || /^ {4}/.test(line);', 'const literal = /^ {4}/.test(line);'],
];
const controls = [['original', original], ['equivalent-control', original.replace('let best = 1;', 'let best = Number(1);')]];
const variants = [...controls, ...faults.map(([id, from, to]) => {
  if (original.split(from).length !== 2) throw new Error(`Nonunique fault ${id}`);
  return [id, original.replace(from, to)];
})];
const deps = process.env.CODEC_NODE_MODULES || path.join(root, 'node_modules');
if (!fs.existsSync(path.join(deps, 'vitest/vitest.mjs'))) throw new Error('Set CODEC_NODE_MODULES to existing dependencies; no install');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codec-value-'));
fs.cpSync(path.join(root, 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'test'), path.join(sandbox, 'test'), { recursive: true });
fs.symlinkSync(path.resolve(deps), path.join(sandbox, 'node_modules'), 'dir');
const config = path.join(sandbox, 'vitest.config.mjs');
fs.writeFileSync(config, `export default ${JSON.stringify({ root: sandbox, oxc: { jsx: {runtime: 'automatic'} }, test: { globals: true, mockReset: true, restoreMocks: true, environment: 'jsdom', setupFiles: ['./test/setup-renderer.ts'], maxWorkers: 1, fileParallelism: false } })}`);
const witness = `import {it} from 'vitest';
import fs from 'node:fs';
import {parsePrompt,serializePrompt,sourcePosition,promptSchema as s} from './prompt-codec';
it('public differential witnesses (observations only)',()=>{
 const signature=(text, exact)=>parsePrompt(text, exact===undefined ? {} : {exact}).toJSON();
 const d=parsePrompt('- **hello** /co');
 const tie=parsePrompt('a\\nb');
 const result={
 'exact-gate': {input:{text:'1. a\\n1. b',exact:true},output:serializePrompt(parsePrompt('1. a\\n1. b',{exact:true})).text},
 'default-exact': {input:{text:'1. a\\n1. b'},output:signature('1. a\\n1. b')},
 'dropped-marks': {input:{text:'**bold**'},output:signature('**bold**')},
 'cached-position': {input:{text:'- **hello** /co'},output:serializePrompt(d)},
 'boundary-tie': {input:{text:'a\\nb',offset:1.5},output:sourcePosition(tie,1.5)},
 'numbering': {input:{text:'8. a\\n9. b'},output:serializePrompt(parsePrompt('8. a\\n9. b')).text},
 'fence-literal': {input:{text:'\x60\x60\x60\\n**literal**\\n\x60\x60\x60'},output:signature('\x60\x60\x60\\n**literal**\\n\x60\x60\x60')}
 }; fs.writeFileSync(${JSON.stringify(path.join(sandbox, 'witness.json'))},JSON.stringify(result));
});`;
fs.writeFileSync(path.join(sandbox, rel, 'behavior-witness.test.ts'), witness);
let report = { schemaVersion: 1, base: 'f5c566f89e093f4cb9322cc59b37de7ee2798331', createdAt: new Date().toISOString(), runtime: {node: process.version, platform:process.platform, arch:process.arch, vitest:JSON.parse(fs.readFileSync(path.join(deps,'vitest/package.json'))).version}, hashes: {original:sha(original),baselineTests:sha(baselineTests),stronger:sha(stronger),runner:sha(fs.readFileSync(fileURLToPath(import.meta.url)))}, limits: {mutants:8,subprocesses:90,executionMs:180000,workers:1}, groups, faults: faults.map(([id,from,to])=>({id,from,to})), runs: [], witnesses: {} };
fs.mkdirSync(out,{recursive:true});
const finalSubset = process.argv.includes('--final-subset');
const refinement = finalSubset || process.argv.includes('--refine');
if (refinement) {
 const currentHashes=report.hashes;
 report=JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8'));
 report.refinementHistory=[...(report.refinementHistory||[]),...(report.refinement?[report.refinement]:[])];
 report.refinement={finalSubset,reason:'Refined experimental integer tie/fence assertions; final subset removes unspecified tie direction and numeric array in favor of visible selections',previousHashes:report.hashes};
 report.hashes=currentHashes;
} else fs.writeFileSync(path.join(out,'predeclared.json'),JSON.stringify({...report,runs:undefined,witnesses:undefined},null,2));
const setupAttempts = JSON.parse(fs.readFileSync(path.join(out, 'setup-attempts.json'), 'utf8')).runs;
const priorMs = setupAttempts.reduce((n,r)=>n+r.elapsedMs,0);
report.setupAttempts = setupAttempts;
const start = performance.now() - (refinement ? report.executionMs : priorMs);
let expected = refinement ? report.runs.find(r=>r.id==='original'&&r.mode==='baseline'&&!r.omitted).tests.filter(t=>t.file.endsWith('prompt-codec.test.ts')).map(t=>t.identity) : undefined;
function run(id, mode, omitted) {
 if(report.runs.length+setupAttempts.length>=90 || performance.now()-start>=180000) throw new Error('Execution budget exhausted');
 const json=path.join(sandbox,'result.json'); fs.rmSync(json,{force:true});
 const consumer=mode==='consumer';
 const files=consumer ? [`${rel}/PromptMarkdown.test.tsx`] : [`${rel}/prompt-codec.test.ts`, ...(mode==='baseline' && !omitted ? [`${rel}/behavior-witness.test.ts`] : [])];
 const args=[path.join(deps,'vitest/vitest.mjs'),'run','--config',config,'--maxWorkers=1','--no-file-parallelism','--reporter=json','--outputFile',json,...files];
 if(omitted) args.push('--testNamePattern',`^(?!.*(?:${groups[omitted].join('|')})).*$`);
 const now=performance.now();
 const r=spawnSync(process.execPath,args,{cwd:sandbox,encoding:'utf8',timeout:Math.min(20000,180000-(now-start)),maxBuffer:8*1024*1024});
 const elapsedMs=performance.now()-now;
 let data; try {data=JSON.parse(fs.readFileSync(json,'utf8'));}catch{}
 const assertions=(data?.testResults||[]).flatMap(f=>f.assertionResults.map(t=>({file:path.relative(sandbox,f.name),identity:t.fullName,status:t.status,durationMs:t.duration??null,failures:t.failureMessages||[]})));
 const active=assertions.filter(t=>t.status!=='pending' && t.status!=='skipped');
 const codec=active.filter(t=>t.file.endsWith('prompt-codec.test.ts'));
 if(!expected && id==='original'&&mode==='baseline'&&!omitted) {
  expected=codec.map(t=>t.identity);
  for(const name of expected) if(Object.values(groups).filter(prefixes=>prefixes.some(p=>name.includes(p))).length!==1) throw new Error('Ungrouped/ambiguous '+name);
 }
 let identityCheck=true;
 if(!consumer && expected) {
  const names=mode==='stronger' ? [...expected,'behavior-value: preserves supported strong and emphasis semantics','behavior-value: maps visible selections to slash token and marked text','behavior-value: keeps fenced emphasis visibly literal and unmarked'] : expected.filter(name=>!omitted||!groups[omitted].some(p=>name.includes(p)));
  identityCheck=JSON.stringify(codec.map(t=>t.identity).sort())===JSON.stringify(names.sort());
 }
 const failed=active.filter(t=>t.status==='failed');
 const assertionOnly=failed.length>0 && failed.every(t=>t.failures.length && t.failures.every(m=>/AssertionError|expected .* to |expected .*not to /s.test(m)));
 const outcome=r.error?.code==='ETIMEDOUT'?'timeout':!data||!identityCheck||!active.length?'invalid':r.status===0&&failed.length===0?'pass':assertionOnly?'assertion-kill':'invalid';
 const row={id,mode,omitted:omitted||null,elapsedMs,exitCode:r.status,outcome,identityCheck,activeCount:active.length,codecCount:codec.length,tests:assertions,diagnostic:outcome==='invalid'?{output:(r.stderr+r.stdout).slice(-5000),suites:data?.testResults,unhandled:data?.unhandledErrors}:undefined};
 report.runs.push(row);
 if(mode==='baseline'&&!omitted&&fs.existsSync(path.join(sandbox,'witness.json'))) { report.witnesses[id]=JSON.parse(fs.readFileSync(path.join(sandbox,'witness.json'),'utf8'));fs.rmSync(path.join(sandbox,'witness.json')); }
 console.log(`${id} ${mode} ${omitted||'all'}: ${outcome} (${active.length}, ${Math.round(elapsedMs)}ms)`);
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
 if((controls.some(([control])=>control===id) && outcome!=='pass') || !identityCheck || outcome==='invalid'||outcome==='timeout') throw new Error(`Unusable ${id}/${mode}/${omitted}: ${outcome}`);
}
try {
 for(const [id,source] of variants){
  if(finalSubset && !['original','equivalent-control','cached-position','boundary-tie','fence-literal'].includes(id)) continue;
  fs.writeFileSync(path.join(sandbox,rel,'prompt-codec.ts'),source);
  fs.writeFileSync(path.join(sandbox,rel,'prompt-codec.test.ts'),baselineTests);
  if(!refinement) run(id,'baseline');
  if(!refinement) for(const group of Object.keys(groups))run(id,'baseline',group);
  fs.writeFileSync(path.join(sandbox,rel,'prompt-codec.test.ts'),baselineTests+stronger);
  run(id,'stronger');
  if(!refinement) run(id,'consumer');
 }
} finally {
 report.executionMs=performance.now()-start;
 report.subprocesses=report.runs.length+setupAttempts.length;
 report.finalShippedAssertions=finalSubset ? stronger : report.finalShippedAssertions;
 report.originalPreserved=sha(fs.readFileSync(path.join(root,rel,'prompt-codec.ts')))===sha(original);
 report.differentials=Object.fromEntries(faults.map(([id])=>[id,{inputReached:!!report.witnesses[id]?.[id],observableDivergence:report.witnesses[id]?JSON.stringify(report.witnesses.original[id].output)!==JSON.stringify(report.witnesses[id][id].output):null,original:report.witnesses.original?.[id],variant:report.witnesses[id]?.[id]}]));
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));
 fs.rmSync(sandbox,{recursive:true,force:true});
}
