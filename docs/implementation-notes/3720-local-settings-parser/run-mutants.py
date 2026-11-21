from pathlib import Path
import hashlib,json,subprocess,sys
repo=Path.cwd()
source=repo/'src/shared/annex-settings-ipc.ts'
original=source.read_bytes()
text=original.decode()
mutants={
 'enumerable-keys-only': ('const keys = Reflect.ownKeys(value);','const keys = Object.keys(value);'),
 'ignore-array-extra-keys': ('if (Reflect.ownKeys(value).length !== length.value + 1) return envelope();','// MUTANT: ignore array own-key count'),
 'silently-deduplicate-touched': ('touched.push(...unset);','for (const key of unset) if (!touched.includes(key)) touched.push(key);'),
 'ignore-origin-consistency': ("if (touched.some(key => !origins[origin].includes(key)) || origin === 'command-palette' && touched.length !== 1) return schema(id);",'// MUTANT: ignore origin consistency'),
 'allow-future-field-version': ('if (!version(value) || value > revision) return schema(id);','if (!version(value)) return schema(id);'),
 'ignore-protocol-version': ("if (top.v.value !== 1 || !isOrigin(top.origin.value)) return schema(id);","if (!isOrigin(top.origin.value)) return schema(id);"),
 'allow-unpaired-surrogates': ('value.length > limits[key] || !wellFormed(value)','value.length > limits[key]'),
 'trust-reflection-parser-error': ('try { return read(); } catch { return envelope(); }','return read();'),
}
summary=[]
try:
 for label,(old,new) in mutants.items():
  assert text.count(old)==1,label
  source.write_text(text.replace(old,new))
  argv=[sys.executable,'docs/implementation-notes/3720-local-settings-parser/run-proof.py','sealed-mutant-'+label,'1','node','node_modules/vitest/vitest.mjs','run','--config','.cache/3720-parser/vitest.config.ts','--configLoader','runner','--maxWorkers','1','--no-file-parallelism','src/shared/annex-settings-ipc.test.ts']
  result=subprocess.run(argv,text=True,capture_output=True)
  receipt=json.loads((repo/('.cache/3720-parser/records/sealed-mutant-'+label+'.json')).read_text())
  assert result.returncode==0,(label,result.stdout,result.stderr)
  assert receipt['actualExit']==1 and 'AssertionError' in receipt['stderr'],label
  summary.append({'label':label,'actualExit':receipt['actualExit'],'assertionFailure':True,'mutatedSourceSHA256':receipt['inputSHA256']['src/shared/annex-settings-ipc.ts']})
  print(label+': assertion failure observed')
  source.write_bytes(original)
finally:
 source.write_bytes(original)
 assert source.read_bytes()==original
(repo/'.cache/3720-parser/sealed-mutant-summary.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'originalSourceSHA256':hashlib.sha256(original).hexdigest(),'restoredSourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'runnerSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'mutants':summary},indent=2)+'\n')
