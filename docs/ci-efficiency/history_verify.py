import csv,hashlib,pathlib,subprocess,os,math,collections
p=pathlib.Path('docs/ci-efficiency/data')
def rows(n):return list(csv.DictReader((p/n).open()))
def hashes():return {f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in p.glob('*')}
a=hashes();env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')
subprocess.run(['python3','docs/ci-efficiency/history_analysis.py','--offline'],check=True,stdout=subprocess.DEVNULL,env=env)
subprocess.run(['python3','docs/ci-efficiency/history_validate_analysis.py'],check=True,stdout=subprocess.DEVNULL,env=env)
assert a==hashes(),'offline output not byte-identical'
r=rows('history-runs.csv');j=rows('history-jobs.csv');s=rows('history-strata.csv')
assert len(r)==2343 and len({x['run_id'] for x in r})==2343
assert sum(int(x['population']) for x in s)==2343
assert sum(int(x['sample']) for x in s)==181
assert len(j)==3278 and len(rows('history-carried-forward.csv'))==37
assert all(x['execution_s']=='0' for x in j if x['os']=='skipped')
assert all('2026-10-25T00:00:00Z'<=x['created_at']<='2026-11-23T23:29:00Z' for x in r)
mac=sum(float(x['execution_s'] or 0)*float(x['weight']) for x in j if x['os']=='macos')
z=next(x for x in rows('history-by-os.csv') if x['os']=='macos')
assert abs(mac-float(z['estimated_seconds']))<.001
assert len(rows('history-validate-replay.csv'))==111
assert sum(int(x['carried_forward']) for x in rows('history-dedup-proof.csv'))==7
for e in rows('history-validate-estimates.csv'):
 if e['epoch']!='all' or e['metric']!='macos_execution_s':continue
 raw=sum(float(x['macos_execution_s'])*float(x['weight']) for x in rows('history-validate-replay.csv') if x['event']==e['event'])
 assert abs(raw-float(e['estimated_total_s']))<.001
print('PASS: repeated offline exports byte-identical; census IDs/window/strata/sample counts; skipped zero seconds; independent Mac weighted total; Validate event totals; 7-row carry-forward proof')
