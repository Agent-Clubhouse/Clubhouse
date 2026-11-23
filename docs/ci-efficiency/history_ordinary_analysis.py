#!/usr/bin/env python3
"""Cached-only Validate PR/main phase and portable envelope analysis. Makes no GETs."""
import argparse, collections, csv, json, math, pathlib, statistics
from history_analysis import stamp, secs, START

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--cache',default='/tmp/clubhouse-ci-history-20261123-cache');p.add_argument('--data',default='docs/ci-efficiency/data');a=p.parse_args();data=pathlib.Path(a.data)
 def read(n):return list(csv.DictReader((data/n).open()))
 runs={r['run_id']:r for r in read('history-runs.csv') if r['workflow']=='Validate'}
 strata=collections.defaultdict(list)
 for r in runs.values():strata[(r['event'],(stamp(r['created_at']).date()-stamp(START).date()).days//7,r['conclusion'] or r['status'])].append(r)
 jobs=collections.defaultdict(list)
 for j in read('history-jobs.csv'):
  if j['run_id'] in runs:jobs[j['run_id']].append(j)
 # Only use IDs already accepted by the original carried-forward deduplication.
 raw={}
 for path in sorted(pathlib.Path(a.cache).glob('*.json')):
  for j in json.loads(path.read_text()).get('jobs',[]):
   if str(j['run_id']) in runs:raw[str(j['id'])]=j
 def family(j):
  n=j['name'].lower()
  if n=='macos unit':return 'macos-unit'
  if n=='macos build + e2e smoke':return 'macos-build-smoke'
  if 'unit + component' in n:return 'unit'
  if 'e2e' in n:return 'e2e'
  if 'build app' in n:return 'build'
  return None
 def phase(name):
  n=name.lower()
  if n.startswith('post ') or n in ['set up job','complete job']:return 'runner-setup-cleanup'
  if 'checkout' in n:return 'checkout'
  if 'setup-node' in n:return 'node-setup'
  if 'npm ci' in n:return 'npm-install'
  if 'macos-specific unit tests' in n:return 'fixed-suite'
  if 'unit tests related to the change' in n:return 'related-tests'
  if 'build unsigned' in n:return 'build-artifact'
  if 'e2e smoke' in n:return 'smoke-tests'
  if 'upload-artifact' in n:return 'artifact-upload'
  if 'actions/cache' in n:return 'cache'
  return 'other-steps'
 # PR/main are event proxies; full-ci label history is unavailable. All these sampled
 # Mac jobs use ordinary short-job names, not the expanded portable Mac matrix.
 eligible={rid for rid,r in runs.items() if r['event']=='pull_request' or (r['event']=='push' and r['branch']=='main')}
 sample={rid for rid in eligible if runs[rid]['sampled']=='1'}
 vals=collections.defaultdict(lambda:collections.defaultdict(float));counts=collections.defaultdict(lambda:collections.Counter());stepcounts=collections.Counter()
 def add(key,rid,value,count=1):
  if value is not None:vals[key][rid]+=value;counts[key][rid]+=count
 for rid in sorted(sample):
  for j in jobs[rid]:
   fam=family(j);os=j['os'];duration=float(j['execution_s'] or 0)
   if os=='skipped' or fam is None:continue
   if os in ['linux','windows'] and fam in ['unit','e2e','build']:
    add(('resource',os,fam,'job-elapsed'),rid,duration)
    add(('resource',os,fam,'cancelled-elapsed'),rid,duration if j['conclusion']=='cancelled' else 0)
   if os=='macos' and fam in ['macos-unit','macos-build-smoke']:
    assert j['job_id'] in raw,'Missing cached job '+j['job_id']
    add(('resource',os,fam,'job-elapsed'),rid,duration)
    add(('resource',os,fam,'cancelled-elapsed'),rid,duration if j['conclusion']=='cancelled' else 0)
    observed=collections.Counter();numbers=collections.Counter()
    for s in raw[j['job_id']].get('steps',[]):
     if s.get('conclusion')=='skipped':continue
     elapsed=secs(s.get('started_at'),s.get('completed_at'))
     if elapsed is None:continue
     ph=phase(s['name']);observed[ph]+=elapsed;numbers[ph]+=1
    # Preserve signed residual, exposing overlap/clock discrepancies instead of hiding them.
    observed['job-minus-observed-steps']=duration-sum(observed.values())
    for ph,elapsed in observed.items():
     key=('phase',os,fam,ph);add(key,rid,elapsed);stepcounts[(key,rid)]+=numbers[ph]
   if os in ['macos','linux','windows'] and fam in ['unit','e2e','build','macos-unit','macos-build-smoke']:
    # Max lag per run/family avoids interpreting parallel waits as runner consumption.
    lag=secs(j['created_at'],j['started_at'])
    if lag is not None:
     key=('delay',os,fam,'max-job-created-to-start');vals[key][rid]=max(vals[key].get(rid,0),lag);counts[key][rid]+=1
    plans=[x['completed_at'] for x in jobs[rid] if x['name']=='Plan the run' and x['conclusion']=='success' and x['completed_at'] and j['started_at'] and x['completed_at']<=j['started_at']]
    if plans:
     lag=secs(max(plans),j['started_at']);key=('delay',os,fam,'first-start-after-observed-plan')
     vals[key][rid]=min(vals[key].get(rid,lag),lag);counts[key][rid]+=1
 # Combined portable envelope is recomputed on whole-run totals, preserving covariance.
 for os in ['linux','windows','portable']:
  for measure in ['job-elapsed','cancelled-elapsed']:
   for rid in sample:
    source=[v.get(rid,0) for key,v in list(vals.items()) if key[0]=='resource' and key[1] in (['linux','windows'] if os=='portable' else [os]) and key[2] in ['unit','build','e2e'] and key[3]==measure]
    vals[('resource',os,'unit-build-e2e',measure)][rid]=sum(source)
    counts[('resource',os,'unit-build-e2e',measure)][rid]=sum(v.get(rid,0) for key,v in list(counts.items()) if key[0]=='resource' and key[1] in (['linux','windows'] if os=='portable' else [os]) and key[2] in ['unit','build','e2e'] and key[3]==measure)
 for r in read('history-validate-replay.csv'):
  if r['run_id'] in sample:
   for metric in ['first_failed_job_from_created_s','portable_success_from_created_s','first_start_from_created_s']:
    if r[metric]:add(('feedback','portable','run',metric),r['run_id'],float(r[metric]))
 def estimate(v):
  total=var=0
  for rs in strata.values():
   ss=[r for r in rs if r['sampled']=='1'];N=len(rs);n=len(ss);ys=[v.get(r['run_id'],0) for r in ss]
   total+=N*sum(ys)/n
   if n<N:var+=N*N*(1-n/N)*statistics.variance(ys)/n
  return total,math.sqrt(var)
 out=[]
 for event in ['pull_request','push']:
  for ep in ['all','before-2026-11-16','from-2026-11-16']:
   domain={rid for rid in eligible if runs[rid]['event']==event and (ep=='all' or (runs[rid]['created_at']>='2026-11-16T00:00:00Z')==(ep=='from-2026-11-16'))}
   for key in sorted(vals):
    v={rid:val for rid,val in vals[key].items() if rid in domain};total,se=estimate(v);nrun,nrunse=estimate({rid:1 for rid in v})
    count,_=estimate({rid:counts[key][rid] for rid in v});mean=total/nrun if nrun else None
    _,ratiose=estimate({rid:v.get(rid,0)-(mean or 0)*(rid in v) for rid in sample})
    out.append({'event':event,'epoch':ep,'kind':key[0],'os':key[1],'family':key[2],'phase_or_metric':key[3],'census_runs':len(domain),'sample_runs':len(sample&domain),'sample_runs_with_observation':len(v),'sample_job_or_endpoint_observations':sum(counts[key][rid] for rid in v),'sample_steps':sum(stepcounts[(key,rid)] for rid in v),'estimated_job_or_endpoint_observations':round(count,3),'estimated_total_s':round(total,3),'seconds_per_census_run':round(total/len(domain),3),'design_se_per_census_run_s':round(se/len(domain),3),'conditional_seconds_per_observed_run':round(mean,3) if mean is not None else None,'conditional_design_se_s':round(ratiose/nrun,3) if nrun else None})
 with (data/'history-phases.csv').open('w') as f:
  w=csv.DictWriter(f,fieldnames=list(out[0]));w.writeheader();w.writerows(out)
 # The phase decomposition must reconcile to the same accepted deduplicated jobs.
 for rid in sample:
  for fam in ['macos-unit','macos-build-smoke']:
   actual=vals[('resource','macos',fam,'job-elapsed')].get(rid,0)
   summed=sum(v.get(rid,0) for key,v in vals.items() if key[:3]==('phase','macos',fam))
   assert abs(actual-summed)<1e-6,(rid,fam,actual,summed)
 print('Cached-only ordinary analysis:',len(sample),'sample runs;',len(out),'aggregate rows; Mac phase reconciliation passes')
if __name__=='__main__':main()
