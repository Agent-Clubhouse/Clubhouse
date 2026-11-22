const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const originalDirectory = path.resolve('docs/evidence/3613-native-handoff-ingress/candidate');
const outputDirectory = path.resolve('docs/evidence/3613-native-handoff-ingress/trust-correction');
const cache = path.resolve('node_modules/.cache/native-handoff-ingress');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = (bytes) => ({ bytes: bytes.length, sha256: sha(bytes) });
const originalBytes = fs.readFileSync(path.join(originalDirectory, 'manifest.json'));
assert.equal(sha(originalBytes), '1238141e78d13e9ed916c3a94c57b25046aeddb7b6cbeaf9e9a3ff77cc687f59');
const original = JSON.parse(originalBytes);
const corrected = JSON.parse(originalBytes);
const readArchive = (name) => {
  const descriptor = original.artifacts.find((entry) => entry.name === name);
  assert(descriptor, `Unbound archive: ${name}`);
  const stored = fs.readFileSync(path.join(originalDirectory, name));
  assert.equal(stored.length, descriptor.stored.bytes);
  assert.equal(sha(stored), descriptor.stored.sha256);
  const raw = zlib.gunzipSync(stored);
  assert.equal(raw.length, descriptor.raw.bytes);
  assert.equal(sha(raw), descriptor.raw.sha256);
  return { descriptor, raw };
};
const decode = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_entity, name) => {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  if (name[0] !== '#') return named[name];
  return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
});
const attribute = (attributes, name) => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
  assert(match, `Missing exact ${name} attribute`);
  return match[1];
};
const bindings = [];
const groups = [
  { key: 'final', xml: 'artifacts/14-native-final-original.xml.gz', rows: corrected.final.cases, count: 110 },
  { key: 'queue', xml: 'artifacts/15-queue-mutant-original.xml.gz', rows: corrected.mutants[0].result.cases, count: 31 },
  { key: 'postauth', xml: 'artifacts/16-postauth-mutant-original.xml.gz', rows: corrected.mutants[1].result.cases, count: 44 },
];
for (const group of groups) {
  const archive = readArchive(group.xml);
  const xml = archive.raw.toString('utf8');
  const matches = [...xml.matchAll(/<testcase\b([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
  assert.equal(matches.length, group.count);
  assert.equal(group.rows.length, group.count);
  const cases = matches.map((match, index) => {
    const nameAttribute = attribute(match[1], 'name'), classAttribute = attribute(match[1], 'classname');
    const actual = { name: decode(nameAttribute), class: decode(classAttribute),
      status: /<(failure|error)\b/.test(match[2] ?? '') ? 'fail' : /<skipped\b/.test(match[2] ?? '') ? 'skipped' : 'pass' };
    const prior = group.rows[index];
    assert.equal(prior.class, actual.class);
    assert.equal(prior.status, actual.status);
    assert.equal(prior.name, actual.class);
    assert.notEqual(prior.name, actual.name);
    bindings.push({ group: group.key, ordinal: index, archive: group.xml,
      rawXml: identity(archive.raw), testcaseFragment: identity(Buffer.from(match[0])),
      nameAttribute, classAttribute, originalName: prior.name, ...actual });
    group.rows[index] = actual;
    return actual;
  });
  assert.equal(cases.filter((test) => test.status === 'pass').length,
    group.key === 'final' ? corrected.final.pass : corrected.mutants.find((entry) => entry.name === group.key).result.pass);
}
assert.equal(bindings.length, 185);
const originalCollector = readArchive('artifacts/collector-original.cjs.gz').raw;
const correctedCollector = fs.readFileSync(path.join(cache, 'collector-c2-corrected.cjs'));
const expectedCollector = originalCollector.toString('utf8')
  .replace('/name="([^"]*)"/', '/(?:^|\\s)name="([^"]*)"/')
  .replace('/classname="([^"]*)"/', '/(?:^|\\s)classname="([^"]*)"/');
assert.equal(correctedCollector.toString('utf8'), expectedCollector);
const originalReport = fs.readFileSync(path.join(cache, '1172-source-review.md'));
corrected.caseNameCorrection = {
  originalProof: '0da6a65fa4973658efe9964a4971ad9bc85d1912', originalManifest: identity(originalBytes),
  originalReview: '1172df1dde737d8ab3be33be44252103683e98b6',
  originalReviewBlob: '767036e93c31c22fc670685eaadcea69f152a241', originalReviewIdentity: identity(originalReport),
  originalCollector: identity(originalCollector), correctedCollector: identity(correctedCollector),
  changedNames: bindings.length, bindings,
  attribution: 'Corrected historical derived view of SAME archived XML, not a new execution or successor-source coverage claim.',
  noTestsCompilerLintOrCiRerun: true,
};
fs.writeFileSync(path.join(outputDirectory, 'corrected-historical-case-manifest.json'), `${JSON.stringify(corrected, null, 2)}\n`);
const storedCollector = zlib.gzipSync(correctedCollector, { level: 9, mtime: 0 });
fs.writeFileSync(path.join(outputDirectory, 'artifacts/collector-c2-corrected-original.cjs.gz'), storedCollector);
console.log(JSON.stringify({ correctedNames: bindings.length,
  groups: groups.map((group) => ({ name: group.key, actualCases: group.count })),
  unchangedRawArchives: groups.map((group) => ({ name: group.xml, raw: readArchive(group.xml).descriptor.raw })),
  originalManifest: identity(originalBytes), correctedManifest: identity(fs.readFileSync(path.join(outputDirectory, 'corrected-historical-case-manifest.json'))),
  correctedCollector: identity(correctedCollector), storedCollector: identity(storedCollector) }, null, 2));
