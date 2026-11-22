const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const ts = require('typescript');

const sourceHead = 'd333225e04312a8d5862a7b505decf72aa58a775';
const file = 'src/main/services/managed-agents/delivery.test.ts';
const prior = execFileSync('git', ['show', `${sourceHead}:${file}`], { encoding: 'utf8' });
const current = readFileSync(file, 'utf8');
const emit = (source) => ts.transpileModule(source, {
  fileName: file,
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    sourceMap: false,
  },
}).outputText;
const before = emit(prior);
const after = emit(current);
assert.equal(after, before, 'Fixture type annotations changed emitted executable code');
console.log(JSON.stringify({
  baselineSourceHead: sourceHead,
  emittedJavaScriptIdentical: true,
  emittedSha256: createHash('sha256').update(after).digest('hex'),
}));
