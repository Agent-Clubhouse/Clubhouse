#!/usr/bin/env python3
"""Cached, bounded GET-only GitHub Actions census + deterministic job sample.
No logs, secrets, actor identities, runner host names, or billing data are exported.
"""
import argparse, collections, concurrent.futures, csv, datetime as dt, hashlib, json, pathlib, subprocess, threading, urllib.parse
UTC=dt.timezone.utc
START='2026-10-25T00:00:00Z'; END='2026-11-23T23:29:00Z'
def stamp(s): return dt.datetime.fromisoformat(s.replace('Z','+00:00')) if s else None
def secs(a,b): return max(0,(stamp(b)-stamp(a)).total_seconds()) if a and b else None
def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--cache',default='/tmp/clubhouse-ci-history-20261123-cache'); p.add_argument('--out',default='docs/ci-efficiency/data')
 p.add_argument('--repo',default='Agent-Clubhouse/Clubhouse'); p.add_argument('--budget',type=int,default=600)
 p.add_argument('--per-stratum',type=int,default=3); p.add_argument('--offline',action='store_true'); a=p.parse_args()
 cache=pathlib.Path(a.cache); cache.mkdir(parents=True,exist_ok=True); out=pathlib.Path(a.out); out.mkdir(parents=True,exist_ok=True)
 calls=0; manifest={}; seen_at={}; budget_lock=threading.Lock()
 def get(endpoint):
  nonlocal calls
  f=cache/(digest(endpoint)+'.json'); manifest[endpoint]=str(f)
  if not f.exists():
   with budget_lock:
    if a.offline or calls>=a.budget: raise RuntimeError('Uncached endpoint or exhausted GET budget: '+endpoint)
    calls+=1
   data=subprocess.check_output(['gh','api','--method','GET',endpoint],text=True)
   json.loads(data); f.write_text(data)
  seen_at[endpoint]=dt.datetime.fromtimestamp(f.stat().st_mtime,UTC).isoformat()
  return json.loads(f.read_text())
 def pages(path,key,**params):
  result=[]; page=1
  while True:
   endpoint=path+'?'+urllib.parse.urlencode(dict(params,per_page=100,page=page))
   obj=get(endpoint); rows=obj[key]; result.extend(rows)
   if key=='workflow_runs' and obj.get('total_count',0)>=1000: raise RuntimeError('Slice reaches API 1000 cap; subdivide '+endpoint)
   if len(rows)<100:
    if key=='workflow_runs' and len(result)!=obj['total_count']: raise RuntimeError('Census total_count mismatch '+endpoint)
    break
   page+=1
  return result
 before=get('rate_limit')['resources']['core']
 base='repos/'+a.repo+'/actions'; runs={}; slices=[]
 day=stamp(START)
 while day<=stamp(END):
  end=min(day+dt.timedelta(days=1)-dt.timedelta(seconds=1),stamp(END))
  date_range=day.strftime('%Y-%m-%dT%H:%M:%SZ')+'..'+end.strftime('%Y-%m-%dT%H:%M:%SZ')
  rows=pages(base+'/runs','workflow_runs',created=date_range)
  # Runs endpoint caps at 1000; fail rather than silently truncate a busy day.
  if len(rows)>=1000: raise RuntimeError('Slice at 1000 cap; subdivide '+date_range)
  slices.append({'start':date_range.split('..')[0],'end':date_range.split('..')[1],'runs':len(rows)})
  for r in rows: runs[r['id']]=r
  day+=dt.timedelta(days=1)
 print('CENSUS',len(runs),'runs;',calls,'network GETs',flush=True)
 def write(name,rows,fields=None):
  rows=list(rows)
  if not rows and not fields: return
  with (out/name).open('w') as f:
   w=csv.DictWriter(f,fieldnames=fields or list(rows[0]),lineterminator='\n'); w.writeheader(); w.writerows(rows)
 def stratum(r):
  week=(stamp(r['created_at']).date()-stamp(START).date()).days//7
  return (r.get('name') or str(r['workflow_id']),r['event'],str(week),r.get('conclusion') or r['status'])
 strata=collections.defaultdict(list)
 for r in runs.values(): strata[stratum(r)].append(r)
 selected=[]; weights={}
 for key,rs in sorted(strata.items()):
  pick=sorted(rs,key=lambda r:digest('ci-history-v1:'+str(r['id'])))[:a.per_stratum]
  for r in pick: selected.append(r); weights[r['id']]=len(rs)/len(pick)
 write('history-runs.csv',({'run_id':r['id'],'head_sha':r['head_sha'],'workflow':r.get('name'),'workflow_id':r['workflow_id'],'event':r['event'],'branch':r['head_branch'],'day':r['created_at'][:10],'created_at':r['created_at'],'updated_at':r['updated_at'],'status':r['status'],'conclusion':r.get('conclusion'),'attempts':r['run_attempt'],'observed_lifecycle_s':secs(r['created_at'],r['updated_at']),'sampled':int(r['id'] in weights)} for r in sorted(runs.values(),key=lambda r:r['id'])))
 write('history-slices.csv',slices)
 for dimension in ['workflow','event','head_branch','day']:
  groups=collections.defaultdict(list)
  for r in runs.values():
   key=r.get('name') if dimension=='workflow' else r['created_at'][:10] if dimension=='day' else r[dimension]
   groups[key].append(r)
  write('history-census-by-'+dimension+'.csv',({'group':k,'runs':len(rs),'success':sum(r.get('conclusion')=='success' for r in rs),'failure':sum(r.get('conclusion')=='failure' for r in rs),'cancelled':sum(r.get('conclusion')=='cancelled' for r in rs),'incomplete':sum(r['status']!='completed' for r in rs),'rerun_runs':sum(r['run_attempt']>1 for r in rs),'observed_attempts':sum(r['run_attempt'] for r in rs)} for k,rs in sorted(groups.items())))
 write('history-strata.csv',({'workflow':k[0],'event':k[1],'week_index':k[2],'outcome':k[3],'population':len(rs),'sample':min(len(rs),a.per_stratum),'weight':len(rs)/min(len(rs),a.per_stratum)} for k,rs in sorted(strata.items())))
 # Concrete carried-forward regression fixture, using the same fingerprint as analysis.
 proof=[]; proof_seen=set()
 for attempt in [1,2]:
  for j in pages(base+'/runs/44159641801/attempts/'+str(attempt)+'/jobs','jobs'):
   fp=(j['name'],j.get('started_at'),j.get('completed_at'),j.get('runner_name'),j.get('status'),j.get('conclusion'))
   carried=fp in proof_seen; proof_seen.add(fp)
   proof.append({'run_id':44159641801,'reported_attempt':attempt,'job_id':j['id'],'name':j['name'],'started_at':j.get('started_at'),'completed_at':j.get('completed_at'),'carried_forward':int(carried)})
 assert sum(j['carried_forward'] for j in proof)==7, 'Carried-forward fixture changed; review evidence'
 assert any(j['reported_attempt']==2 and j['name']=='Build macOS (arm64)' and not j['carried_forward'] for j in proof)
 write('history-dedup-proof.csv',proof)
 # Four concurrent read-only requests; capped before dispatch by one shared lock.
 def prefetch(r):
  for attempt in range(1,r['run_attempt']+1):
   pages(f"{base}/runs/{r['id']}/attempts/{attempt}/jobs",'jobs')
 if not a.offline:
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   for i,_ in enumerate(pool.map(prefetch,selected)):
    if (i+1)%25==0: print('CACHED JOB RUNS',i+1,'/',len(selected),'GETs',calls,flush=True)
 jobs=[]; duplicates=[]
 for i,r in enumerate(selected):
  execution_seen=set()
  for attempt in range(1,r['run_attempt']+1):
   rows=pages(f"{base}/runs/{r['id']}/attempts/{attempt}/jobs",'jobs')
   for j in rows:
    # Attempt endpoints can carry successful executions forward under new IDs.
    # Include runner identity in private fingerprint; never export host name.
    fp=(j['name'],j.get('started_at'),j.get('completed_at'),j.get('runner_name'),j.get('status'),j.get('conclusion'))
    if fp in execution_seen:
     duplicates.append({'run_id':r['id'],'reported_attempt':attempt,'job_id':j['id'],'name':j['name'],'started_at':j.get('started_at'),'completed_at':j.get('completed_at')}); continue
    execution_seen.add(fp)
    labels=[s.lower() for s in j.get('labels',[])]
    os='macos' if any('macos' in s for s in labels) else 'windows' if any('windows' in s for s in labels) else 'linux' if any('ubuntu' in s or s=='linux' for s in labels) else 'unknown'
    duration=secs(j.get('started_at'),j.get('completed_at'))
    # Skipped jobs may have synthetic timestamps; never count these as execution.
    if j.get('conclusion')=='skipped': os='skipped'; duration=0
    jobs.append({'run_id':r['id'],'reported_attempt':attempt,'job_id':j['id'],'workflow':r.get('name'),'event':r['event'],'branch':r['head_branch'],'day':r['created_at'][:10],'name':j['name'],'os':os,'labels':'|'.join(j.get('labels',[])),'status':j['status'],'conclusion':j.get('conclusion'),'created_at':j.get('created_at'),'started_at':j.get('started_at'),'completed_at':j.get('completed_at'),'execution_s':duration,'created_to_start_s':secs(j.get('created_at'),j.get('started_at')),'weight':weights[r['id']]})
  if (i+1)%25==0: print('JOBS',i+1,'/',len(selected),'GETs',calls,flush=True)
 write('history-jobs.csv',jobs)
 write('history-carried-forward.csv',duplicates,['run_id','reported_attempt','job_id','name','started_at','completed_at'])
 # Weighted totals estimate the run-created cohort, including all observed attempts.
 for dimension in ['os','workflow','event','branch','day','name']:
  population_counts=collections.Counter((r.get('name') if dimension=='workflow' else r['event'] if dimension=='event' else r['head_branch'] if dimension=='branch' else r['created_at'][:10] if dimension=='day' else None) for r in runs.values())
  ag=collections.defaultdict(lambda: {'sample_jobs':0,'sample_seconds':0,'estimated_jobs':0,'estimated_seconds':0,'sample_failures':0,'sample_cancelled':0,'sample_unknown_duration':0,'estimated_failures':0,'estimated_cancelled':0})
  for j in jobs:
   key=(j[dimension],j['os']) if dimension!='os' else (j['os'],)
   z=ag[key]; z['sample_jobs']+=1; z['sample_seconds']+=j['execution_s'] or 0
   z['estimated_jobs']+=j['weight']; z['estimated_seconds']+=(j['execution_s'] or 0)*j['weight']
   z['sample_failures']+=j['conclusion']=='failure'; z['sample_cancelled']+=j['conclusion']=='cancelled'; z['estimated_failures']+=j['weight']*(j['conclusion']=='failure'); z['estimated_cancelled']+=j['weight']*(j['conclusion']=='cancelled'); z['sample_unknown_duration']+=j['execution_s'] is None
  write('history-by-'+dimension+'.csv',({**{dimension:k[0]},**({'os':k[1]} if dimension!='os' else {}),**{q:round(v,3) for q,v in z.items()},'estimated_seconds_per_census_run':round(z['estimated_seconds']/len(runs),3),'group_census_runs':population_counts.get(k[0],len(runs)),'estimated_seconds_per_group_run':round(z['estimated_seconds']/population_counts.get(k[0],len(runs)),3)} for k,z in sorted(ag.items())))
 runstats=[]
 for r in selected:
  js=[j for j in jobs if j['run_id']==r['id']]; timed=[j for j in js if j['os']!='skipped' and j['started_at'] and j['completed_at']]
  first=min((j['started_at'] for j in timed),default=None); last=max((j['completed_at'] for j in timed),default=None)
  runstats.append({'run_id':r['id'],'workflow':r['name'],'weight':weights[r['id']],'jobs':len(js),'execution_s':sum(j['execution_s'] or 0 for j in js),'macos_execution_s':sum(j['execution_s'] or 0 for j in js if j['os']=='macos'),'observed_job_span_s':secs(first,last),'run_created_to_first_start_s':secs(r['created_at'],first),'longest_job_s':max((j['execution_s'] for j in timed),default=None)})
 write('history-sampled-runs.csv',runstats)
 def weighted_percentile(pairs,q):
  pairs=sorted((v,w) for v,w in pairs if v is not None)
  if not pairs: return None
  target=sum(w for v,w in pairs)*q; acc=0
  for v,w in pairs:
   acc+=w
   if acc>=target: return v
 timing=[]
 for os in ['macos','linux','windows','unknown']:
  js=[j for j in jobs if j['os']==os]
  for metric in ['execution_s','created_to_start_s']:
   timing.append({'os':os,'metric':metric,'sample_observations':sum(j[metric] is not None for j in js),'weighted_p50_s':weighted_percentile([(j[metric],j['weight']) for j in js],.5),'weighted_p90_s':weighted_percentile([(j[metric],j['weight']) for j in js],.9),'sample_max_s':max((j[metric] for j in js if j[metric] is not None),default=None)})
 write('history-timing.csv',timing)
 summary={'repo':a.repo,'start_inclusive':START,'end_inclusive':END,'census_runs':len(runs),'sample_runs':len(selected),'sample_unique_jobs':len(jobs),'carried_forward_rows_removed':len(duplicates),'network_gets_this_invocation':calls,'cache_endpoints_used':len(manifest),'initial_core_budget':before,'stratification':['workflow','event','7-day index from start','conclusion or status'],'seed':'ci-history-v1','per_stratum':a.per_stratum,'cache_observed_earliest':min(seen_at.values()),'cache_observed_latest':max(seen_at.values())}
 (out/'history-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 (cache/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(json.dumps(summary,indent=2),flush=True)
if __name__=='__main__': main()
