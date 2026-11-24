#!/usr/bin/env node
// Sanitize distribution paths, preserving assertion headers/diffs and test identities.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../docs/ci-efficiency/behavior-value');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const manifestPath=path.join(dir,'redaction.json');
if(fs.existsSync(manifestPath))throw new Error('Already sanitized; raw receipts remain at milestone commit');
const mask=s=>s.replace(/(?:file:\/\/)?\/Users\/[^\s)]+?(?=\/node_modules\/)/g,'<local>')
 .replace(/(?:file:\/\/)?\/Users\/[^\s)]+/g,'<local>')
 .replace(/(?:\/private)?\/var\/folders\/[^\s)]+?\/codec-value-[^/\s)]+/g,'<sandbox>')
 .replace(/\/tmp\/codec-audit-[^/\s)]+/g,'<private-overlay>');
function sanitize(value,key=''){
 if(Array.isArray(value)) return value.map(v=>sanitize(v,key));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,k)]));
 if(typeof value!=='string')return value;
 if(key==='identity'||key==='finalShippedAssertions')return value;
 if(key==='failures'||key==='failureMessages')return value.split('\n').map(line=>/^\s+at /.test(line)?mask(line):line).join('\n');
 if(key==='file'&&value.includes('/src/'))return 'src/'+value.split('/src/').at(-1);
 return mask(value);
}
const files={};
for(const name of ['results.json','setup-attempts.json','dependencies.json']){
 const before=fs.readFileSync(path.join(dir,name),'utf8');
 const after=JSON.stringify(sanitize(JSON.parse(before)),null,2)+'\n';
 fs.writeFileSync(path.join(dir,name),after);files[name]={originalSha256:sha(before),sanitizedSha256:sha(after)};
}
fs.writeFileSync(manifestPath,JSON.stringify({rawMilestoneCommit:'c92abd0b81547089fbe2b7ded914b98f90e63aca',policy:'Only distribution filesystem/stack paths masked. Assertion headers/diffs and test identities retained. File identities canonicalized from macOS /var symlink form to repo-relative src paths. Raw bytes recoverable from immutable milestone commit.',files},null,2)+'\n');
