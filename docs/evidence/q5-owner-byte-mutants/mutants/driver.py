import datetime, hashlib, json, pathlib, subprocess, sys, tempfile
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=False)
expected = {
 'control': None, 'ack-fence': 'ACK-first must synchronously own loss',
 'entered-coercion': 'released entered coverage became ready',
 'recovery-progress': 'no-progress recovery must typed-refuse once',
 'early-state': 'candidate state visible', 'early-revision': 'candidate revision visible',
 'early-digest': 'candidate digest visible', 'early-bytes': 'candidate segment/bytes/file hash visible',
 'early-file-hash': 'candidate segment/bytes/file hash visible',
 'early-anchors': 'new intent anchor/capability visible',
}
rows = []
with tempfile.TemporaryDirectory(prefix='q5-owner-mutant-') as temporary:
 for mode, message in expected.items():
  argv = [subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip(), 'test/research/q5-owner-mutations.cjs', temporary, mode]
  started = datetime.datetime.now(datetime.timezone.utc).isoformat()
  result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
  (out / (mode + '.stdout.txt')).write_bytes(result.stdout)
  (out / (mode + '.stderr.txt')).write_bytes(result.stderr)
  try: meta = json.loads(result.stdout)
  except Exception: meta = None
  targets = 0 if mode == 'control' else (2 if mode.startswith('early-') and mode != 'early-file-hash' else 1)
  ok = result.returncode == (0 if mode == 'control' else 2) and meta is not None and meta.get('targets') == targets
  if mode == 'control': ok = ok and len(meta.get('cases', [])) == 7
  else: ok = ok and message in meta.get('message', '') and 'SAFETY ASSERTION FAILED:' in meta.get('message', '')
  row = {'mode': mode, 'argv': argv, 'startedAt': started, 'finishedAt': finished, 'exit': result.returncode, 'expectedResult': ok, 'stdoutSha256': hashlib.sha256(result.stdout).hexdigest(), 'stderrSha256': hashlib.sha256(result.stderr).hexdigest(), 'parsed': meta}
  rows.append(row); print(json.dumps(row), flush=True)
  (out / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
  if not ok: raise SystemExit(1)
print('Seven baseline controls passed; all nine semantic mutants failed the intended safety assertion.')
