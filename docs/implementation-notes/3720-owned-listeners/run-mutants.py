from pathlib import Path
import hashlib,json,subprocess,sys
repo=Path.cwd();source=repo/'src/main/services/annex-server.ts';original=source.read_bytes();text=original.decode()
old_predicate="""  return () => wasReady && generation === serverGeneration
    && main === tlsServer && pairing === pairingServer && main.listening && pairing.listening
    && serverPort === mainPort && pairingPort === pairPort && boundHost === host;"""
equality_predicate="""  return () => wasReady && !!tlsServer && !!pairingServer && tlsServer.listening && pairingServer.listening
    && serverPort === mainPort && pairingPort === pairPort && boundHost === host;"""
mutants={
 'capture-no-generation': [('wasReady && generation === serverGeneration', 'wasReady')],
 'wrapper-no-generation': [('if (generation !== serverGeneration || main !== tlsServer || pairing !== pairingServer)', 'if (main !== tlsServer || pairing !== pairingServer)')],
 'equality-only-adoption': [(old_predicate,equality_predicate)],
 'superseded-stop': [("throw new AnnexStartFailure(new Error('Annex listener attempt was superseded before confirmation.'), generation, true);", "stop(); throw new AnnexStartFailure(new Error('Annex listener attempt was superseded before confirmation.'), generation, true);")],
 'host-mismatch-stop': [("throw new AnnexStartFailure(new Error('Annex expected listener profile changed before confirmation.'), generation, true);", "stop(); throw new AnnexStartFailure(new Error('Annex expected listener profile changed before confirmation.'), generation, true);")],
 'no-ready-at-capture-latch': [('return () => wasReady && generation === serverGeneration', 'return () => generation === serverGeneration')],
 'ignore-listener-state': [('const wasReady = !!main && !!pairing && main.listening && pairing.listening', 'const wasReady = !!main && !!pairing'),('main === tlsServer && pairing === pairingServer && main.listening && pairing.listening','main === tlsServer && pairing === pairingServer')],
 'accept-http-fallback': [('export function captureSecureListenerReadiness(expectedHost: string): () => boolean {\n  const generation = serverGeneration;\n  const main = tlsServer, pairing = pairingServer;', 'export function captureSecureListenerReadiness(expectedHost: string): () => boolean {\n  const generation = serverGeneration;\n  const main = tlsServer || httpServer, pairing = pairingServer;'),('main === tlsServer && pairing === pairingServer && main.listening','main === (tlsServer || httpServer) && pairing === pairingServer && main.listening')],
}
summary=[]
try:
 for label,changes in mutants.items():
  modified=text
  for old,new in changes:
   assert modified.count(old)==1,label
   modified=modified.replace(old,new)
  source.write_text(modified)
  args=[sys.executable,'docs/implementation-notes/3720-owned-listeners/run-proof.py','mutant-'+label,'1','node','node_modules/vitest/vitest.mjs','run','--config','.cache/3720-owned-listeners/vitest.config.ts','--configLoader','runner','--maxWorkers','1','--no-file-parallelism','src/main/services/annex-server.test.ts','-t','owned secure listener readiness']
  result=subprocess.run(args,text=True,capture_output=True)
  receipt=json.loads((repo/('.cache/3720-owned-listeners/records/mutant-'+label+'.json')).read_text())
  assert result.returncode==0,(label,result.stdout,result.stderr)
  assert receipt['actualExit']==1 and 'AssertionError' in receipt['stderr'],label
  summary.append({'label':label,'actualExit':receipt['actualExit'],'assertionFailure':True,'mutatedSourceSHA256':receipt['inputSHA256']['src/main/services/annex-server.ts']})
  print(label+': assertion failure observed',flush=True)
  source.write_bytes(original)
finally:
 source.write_bytes(original)
 assert source.read_bytes()==original
(repo/'.cache/3720-owned-listeners/mutant-summary.json').write_text(json.dumps({'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'originalSourceSHA256':hashlib.sha256(original).hexdigest(),'restoredSourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'driverSHA256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'mutants':summary},indent=2)+'\n')
