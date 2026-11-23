#!/usr/bin/env python3
"""Recompute Validate replay and domain estimates from sanitized history CSVs; no API."""
import argparse, collections, csv, math, pathlib, statistics
from history_analysis import stamp, secs, START

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data',default='docs/ci-efficiency/data');a=p.parse_args();data=pathlib.Path(a.data)
 def read(name): return list(csv.DictReader((data/name).open()))
 def write(name,rows):
  if not rows:return
  with (data/name).open('w') as f:
   w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
 runs={r['run_id']:r for r in read('history-runs.csv') if r['workflow']=='Validate'}
 js=collections.defaultdict(list)
 for j in read('history-jobs.csv'):
  if j['run_id'] in runs:
   j['execution_s']=float(j['execution_s']) if j['execution_s'] else None;js[j['run_id']].append(j)
 def epoch(r):return 'from-2026-11-16' if r['created_at']>='2026-11-16T00:00:00Z' else 'before-2026-11-16'
 def stratum(r):return (r['event'],(stamp(r['created_at']).date()-stamp(START).date()).days//7,r['conclusion'] or r['status'])
 strata=collections.defaultdict(list)
 for r in runs.values():strata[stratum(r)].append(r)
 def family(name):
  n=name.lower()
  if n=='macos unit':return 'macos-unit'
  if n=='macos build + e2e smoke':return 'macos-build-smoke'
  if 'unit + component' in n:return 'portable-unit'
  if 'e2e' in n:return 'e2e'
  if 'build app' in n:return 'build'
  if 'smoke' in n:return 'package-smoke'
  if any(s in n for s in ['lint','typecheck']):return 'static-checks'
  if 'plan' in n or 'preflight' in n:return 'planning-preflight'
  return 'other'
 replay=[];families=[];metrics={}
 for rid,r in runs.items():
  if r['sampled']!='1':continue
  jobs=js[rid];weight=float(jobs[0]['weight']) if jobs else len(strata[stratum(r)])/sum(x['sampled']=='1' for x in strata[stratum(r)])
  row={k:r[k] for k in ['run_id','head_sha','event','branch','day','created_at','updated_at','conclusion','attempts']};row.update(epoch=epoch(r),weight=weight)
  m={}
  for os in ['linux','windows','macos','unknown']:
   timed=[j for j in jobs if j['os']==os and j['started_at'] and j['completed_at']]
   first=min((j['started_at'] for j in timed),default=None);last=max((j['completed_at'] for j in timed),default=None)
   m[os+'_execution_s']=sum(j['execution_s'] or 0 for j in timed)
   m[os+'_cancelled_execution_s']=sum(j['execution_s'] or 0 for j in timed if j['conclusion']=='cancelled')
   row.update({os+'_first_start':first,os+'_last_complete':last,os+'_observed_span_s':secs(first,last),os+'_longest_job_s':max((j['execution_s'] for j in timed),default=None)})
  first=min((j['started_at'] for j in jobs if j['os']!='skipped' and j['started_at']),default=None)
  fail=min((j['completed_at'] for j in jobs if j['conclusion']=='failure' and j['completed_at']),default=None)
  # Latest visible execution per exact job name, retaining earlier carried success.
  latest={}
  for j in sorted(jobs,key=lambda x:int(x['reported_attempt'])):latest[j['name']]=j
  portable=[j for j in latest.values() if j['os'] in ['linux','windows'] and j['conclusion']!='skipped']
  substantial=all(any(j['os']==os and family(j['name'])=='portable-unit' and (j['execution_s'] or 0)>0 for j in portable) for os in ['linux','windows'])
  unresolved_portable=any(j['os']=='unknown' and family(j['name']) in ['portable-unit','e2e','build'] and j['conclusion']!='success' for j in latest.values())
  complete=max((j['completed_at'] for j in portable),default=None) if substantial and not unresolved_portable and all(j['conclusion']=='success' and j['completed_at'] for j in portable) else None
  m['first_failed_job_from_created_s']=secs(r['created_at'],fail)
  m['portable_success_from_created_s']=secs(r['created_at'],complete)
  m['first_start_from_created_s']=secs(r['created_at'],first)
  row.update(first_actual_start=first,first_failed_job_completed=fail,portable_success_last_complete=complete,**m)
  replay.append(row);metrics[rid]=m
  groups=collections.defaultdict(list)
  for j in jobs:groups[(j['reported_attempt'],j['os'],family(j['name']))].append(j)
  for (attempt,os,fam),xs in sorted(groups.items()):
   families.append({'run_id':rid,'head_sha':r['head_sha'],'event':r['event'],'epoch':epoch(r),'weight':weight,'reported_attempt':attempt,'os':os,'family':fam,'jobs':len(xs),'execution_s':sum(j['execution_s'] or 0 for j in xs),'first_start':min((j['started_at'] for j in xs if j['started_at']),default=None),'last_complete':max((j['completed_at'] for j in xs if j['completed_at']),default=None),'conclusions':'|'.join(k+':'+str(v) for k,v in sorted(collections.Counter(j['conclusion'] for j in xs).items())),'job_names':'|'.join(sorted({j['name'] for j in xs}))})
 write('history-validate-replay.csv',replay);write('history-validate-families.csv',families)
 # Stratified SRS variance with finite-population correction. Hash sample treated as SRS.
 def estimate(values):
  total=0;variance=0
  for rs in strata.values():
   sampled=[r for r in rs if r['sampled']=='1'];N=len(rs);n=len(sampled);ys=[values.get(r['run_id'],0) for r in sampled]
   total+=N*sum(ys)/n
   if n<N:variance+=N*N*(1-n/N)*statistics.variance(ys)/n
  return total,math.sqrt(variance)
 estimates=[]
 for event in ['pull_request','push']:
  for ep in ['all','before-2026-11-16','from-2026-11-16']:
   domain={rid for rid,r in runs.items() if r['event']==event and (ep=='all' or epoch(r)==ep)}
   for metric in next(iter(metrics.values())):
    vals={rid:m[metric] for rid,m in metrics.items() if rid in domain and m[metric] is not None}
    est,se=estimate(vals)
    conditional=metric in ['first_failed_job_from_created_s','portable_success_from_created_s','first_start_from_created_s']
    count,_=estimate({rid:1 for rid in vals})
    mean=(est/count if count else None) if conditional else (est/len(domain) if domain else None)
    if conditional and count:
     _,ratio_se=estimate({rid:vals.get(rid,0)-mean*(rid in vals) for rid in metrics});mean_se=ratio_se/count
    else:mean_se=None if conditional else se/len(domain) if domain else None
    estimates.append({'event':event,'epoch':ep,'metric':metric,'census_runs':len(domain),'sample_runs':sum(rid in domain for rid in metrics),'sample_observations':len(vals),'estimated_observations':round(count,3),'estimated_total_s':round(est,3),'total_design_se_s':round(se,3),'estimated_mean_s':round(mean,3) if mean is not None else None,'mean_design_se_s':round(mean_se,3) if mean_se is not None else None,'denominator':'estimated runs with observed endpoint' if conditional else 'all census runs in event/epoch'})
 write('history-validate-estimates.csv',estimates)
 print('Validate replay:',len(replay),'runs;',len(families),'family rows;',len(estimates),'estimates')
if __name__=='__main__':main()
