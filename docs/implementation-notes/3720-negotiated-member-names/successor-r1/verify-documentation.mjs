// Documentation-vector consistency only. Does not import or execute product code.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const original = JSON.parse(fs.readFileSync(path.join(root, '..', 'fixtures.json'), 'utf8'));
const next = JSON.parse(fs.readFileSync(path.join(root, 'fixtures.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const vector of [...original.hashVectors, ...next.hashVectors]) {
  const r = vector.record;
  const fields = [r.fingerprint, String(r.joinedAt), r.pairingId ?? '', r.name, String(r.at), r.by];
  const bytes = Buffer.concat([Buffer.from('Clubhouse/member-name/1\n'), ...fields.flatMap(x => [Buffer.from(Buffer.byteLength(x) + ':'), Buffer.from(x)])]);
  if (bytes.toString('hex') !== vector.canonicalBytesHex || hash(bytes) !== vector.sha256 || vector.sha256 !== r.id) throw Error('vector mismatch');
  if (vector.utf16CodeUnits !== undefined && vector.utf16CodeUnits !== r.name.length) throw Error('UTF16 vector mismatch');
}
const isTrim = cp => cp >= 0x09 && cp <= 0x0d || [0x20,0xa0,0x1680,0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff].includes(cp) || cp >= 0x2000 && cp <= 0x200a;
const trim = input => { let a=0,b=input.length; while(a<b&&isTrim(input.charCodeAt(a)))a++;while(b>a&&isTrim(input.charCodeAt(b-1)))b--;return input.slice(a,b); };
const wellFormed = s => { for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true; };
for (const item of next.stringCases) {
  const trimmed = trim(item.input);
  const writerValid = wellFormed(item.input) && trimmed.length >= 1 && trimmed.length <= 200;
  const receiverValid = writerValid && trimmed === item.input;
  if (item.writerRefuses ? writerValid : !writerValid || trimmed !== item.writerResult) throw Error('writer fixture mismatch: '+item.id);
  if (receiverValid !== item.modernReceiverAcceptsInput) throw Error('receiver fixture mismatch: '+item.id);
}
const skew = next.cases.find(x => x.id === 'B02-clock-ratchet');
if (skew.acceptedRemoteAt-skew.fastNow !== 86400000 || skew.nextLocalAt !== skew.acceptedRemoteAt+1 || skew.nextLocalAt-skew.slowPeerNow <= 86400000) throw Error('skew fixture mismatch');
console.log('PASS documentation consistency only: 5 frozen + 6 successor canonical hash vectors; 10 Unicode/trim inventory cases; skew arithmetic.');
console.log('No product codec, IPC, store, socket, mixed-version endpoint, race, UI, type or lint execution.');
