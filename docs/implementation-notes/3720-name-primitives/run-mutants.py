from pathlib import Path
import hashlib,json,subprocess,sys
repo=Path.cwd();source=repo/'src/shared/annex-member-names.ts';original=source.read_bytes();text=original.decode()
mutants={
 'utf16-length-prefix': [('String(bytes.length)', 'String(value.length)')],
 'wrong-domain-newline': [("const DOMAIN = 'Clubhouse/member-name/1\\n';", "const DOMAIN = 'Clubhouse/member-name/1\\r\\n';")],
 'nfc-canonicalization': [('payload.name, String(payload.at), payload.by', "payload.name.normalize('NFC'), String(payload.at), payload.by")],
 'ignore-writer-order': [('if (a.by !== b.by) return a.by < b.by ? -1 : 1;', '// MUTANT: no writer tie-break')],
 'ignore-id-order': [('return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;', 'return 0;')],
 'ignore-pairing-epoch': [("    && owns(a, 'pairingId') === owns(b, 'pairingId') && a.pairingId === b.pairingId;", ';')],
 'ignore-joined-epoch': [(' && a.joinedAt === b.joinedAt', '')],
 'reuse-logical-stamp': [('Math.max(now, maximum + 1)', 'Math.max(now, maximum)')],
 'reject-exact-skew-boundary': [('at - now <= MAX_FUTURE_MS', 'at - now < MAX_FUTURE_MS')],
 'broad-go-whitespace': [('|| code === 0xfeff;', '|| code === 0xfeff || code === 0x0085 || code === 0x180e;')],
 'enumerable-only-keys': [('exact ? Reflect.ownKeys(raw)', 'exact ? Object.keys(raw)')],
 'raw-property-read': [('captured[key] = descriptor.value;', 'captured[key] = (raw as Record<string, unknown>)[key];')],
 'allow-unpaired-surrogates': [("if (typeof value !== 'string' || !wellFormed(value)) return null;", "if (typeof value !== 'string') return null;"),('&& wellFormed(value) && trimName(value)', '&& trimName(value)')],
}
summary=[]
try:
 for label,changes in mutants.items():
  modified=text
  for old,new in changes:
   assert modified.count(old)==1,label
   modified=modified.replace(old,new)
  source.write_text(modified)
  argv=[sys.executable,'docs/implementation-notes/3720-name-primitives/run-proof.py','mutant-'+label,'1','node','node_modules/vitest/vitest.mjs','run','--config','.cache/3720-names/vitest.config.ts','--configLoader','runner','--maxWorkers','1','--no-file-parallelism','src/shared/annex-member-names.test.ts']
  result=subprocess.run(argv,text=True,capture_output=True)
  receipt=json.loads((repo/('.cache/3720-names/records/mutant-'+label+'.json')).read_text())
  assert result.returncode==0,(label,result.stdout,result.stderr)
  assert receipt['actualExit']==1 and 'AssertionError' in receipt['stderr'],label
  summary.append({'label':label,'actualExit':receipt['actualExit'],'assertionFailure':True,'mutatedSourceSHA256':receipt['inputSHA256']['src/shared/annex-member-names.ts']})
  print(label+': assertion failure observed')
  source.write_bytes(original)
finally:
 source.write_bytes(original)
 assert source.read_bytes()==original
(repo/'.cache/3720-names/mutant-summary.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'originalSourceSHA256':hashlib.sha256(original).hexdigest(),'restoredSourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'runnerSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'mutants':summary},indent=2)+'\n')
