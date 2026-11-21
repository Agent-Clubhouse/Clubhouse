"""Lightweight deterministic isolated shell simulations; never invokes the live gate.

Each candidate copy rewrites the FOUR fixed coordination paths into a disposable
directory and supplies fake resource/time commands through a private PATH. The
only admitted child is a sentinel-writing shell, never Vitest/tsc or real work.
No production test/resource policy is bypassed by this simulation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
CANDIDATE = HERE / 'candidate.zsh'
FAKE = r'''#!PYTHON
import datetime,json,os,sys
from pathlib import Path
p=Path(os.environ['FAKE_MODEL']);m=json.loads(p.read_text());name=Path(sys.argv[0]).name
def save():p.write_text(json.dumps(m))
if name=='top':
 i=m['next'];m['next']+=1;m['current']=i;s=m['samples'][min(i,len(m['samples'])-1)]
 m['trace'].append({'command':'top','sample':i,'time':m['now'],'slotExists':Path(m['slot']).is_dir()})
 if 'hold' in s:
  h=Path(m['hold'])
  if s['hold'] is None:h.unlink(missing_ok=True)
  else:h.write_text(s['hold'])
 save()
else:s=m['samples'][min(m.get('current',0),len(m['samples'])-1)]
if name in s.get('fail_commands',[]):sys.exit(1)
if name=='top':
 if s.get('malformed_top'):print('Unreadable top');sys.exit(0)
 print('CPU usage: 10% user, 10% sys, '+str(s.get('idle',80))+'% idle')
 print('PhysMem: 40G used (2000M wired, %sM compressor), 9000M unused.'%s.get('compressor',1000))
elif name=='sysctl':
 if s.get('malformed_swap'):print('Unreadable swap');sys.exit(0)
 print('total = 8192.00M  used = %sM  free = %sM  (encrypted)'%(s.get('used',3945),s.get('swap_free',2048)))
elif name=='vm_stat':
 print('Mach Virtual Memory Statistics: (page size of 16384 bytes)')
 for field,val in [('Pages free',s.get('available',32768)*64),('Pages inactive',0),('Pages speculative',0),('Pages purgeable',0),('Pageouts',s.get('pageouts',1000)),('Swapouts',s.get('swapouts',2000))]:
  if field not in s.get('omit_vm',[]):print('%s: %s.'%(field,val))
elif name=='memory_pressure':
 if not s.get('malformed_pressure'):print('System-wide memory free percentage: %s%%'%s.get('freepct',87))
elif name=='ps':
 if sys.argv[-1]=='comm=':
  print('/usr/bin/swift-frontend' if s.get('swift') else '/sbin/launchd')
 else:
  print('123 /usr/local/bin/node vitest' if s.get('node') else '123 /Applications/Example.app vitest-text-only')
elif name=='date':
 print(m['now'] if sys.argv[-1]=='+%s' else datetime.datetime.fromtimestamp(m['now'],datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
elif name=='stat':
 if m.get('stat_fail'):sys.exit(1)
 print(int(Path(sys.argv[-1]).stat().st_mtime))
elif name=='sleep':
 m['trace'].append({'command':'sleep','seconds':int(sys.argv[1]),'time':m['now'],'slotExists':Path(m['slot']).is_dir()})
 if m.get('sleep_fail'):save();sys.exit(1)
 m['now']+=int(sys.argv[1]);save()
elif name=='tee':
 body=sys.stdin.read();sys.stdout.write(body)
 if m.get('tee_fail'):sys.exit(1)
 with open(sys.argv[-1],'a') as out:out.write(body)
else:raise RuntimeError(name)
'''


class GateTests(unittest.TestCase):
    def run_gate(self, samples=None, age=1800, baseline='1812\n', minimum=4,
                 dry=False, slot=False, child_exit=0, **flags):
        with tempfile.TemporaryDirectory(prefix='gate-fake-only-') as tmp:
            root = Path(tmp)
            paths = {'lock': root/'slot', 'log': root/'events.txt',
                     'swapbase': root/'baseline', 'hold': root/'hold'}
            text = CANDIDATE.read_text()
            originals = {'lock':'/tmp/clubhouse-desktop-test.lock',
                         'log':'/tmp/clubhouse-desktop-test-gate.log',
                         'swapbase':'/tmp/clubhouse-desktop-test.swapbase',
                         'hold':'/tmp/clubhouse-desktop-hold'}
            for name, original in originals.items():
                text = text.replace(original, str(paths[name]))
            self.assertNotIn('/tmp/clubhouse-desktop', text)
            candidate = root/'candidate.zsh'; candidate.write_text(text)
            now = 100000
            if baseline is not None:
                paths['swapbase'].write_text(baseline)
                os.utime(paths['swapbase'], (now-age, now-age))
            if slot:
                paths['lock'].mkdir(); (paths['lock']/'owner').write_text('other-real-owner')
            before = (paths['swapbase'].read_bytes(), paths['swapbase'].stat().st_mtime_ns) if baseline is not None else None
            model = {'samples':samples or [{}, {}, {}, {}], 'now':now, 'next':0,
                     'trace':[], 'slot':str(paths['lock']), 'hold':str(paths['hold']), **flags}
            model_path = root/'model.json'; model_path.write_text(json.dumps(model))
            bin_dir = root/'bin'; bin_dir.mkdir()
            for name in ['top','sysctl','vm_stat','memory_pressure','ps','date','stat','sleep','tee']:
                program=bin_dir/name; program.write_text(FAKE.replace('PYTHON',sys.executable,1)); program.chmod(0o700)
            child = root/'child'
            args = [shutil.which('zsh'), str(candidate)] + (['--dry-run'] if dry else [])
            args += ['fake-only',str(minimum),'--','/bin/sh','-c',f'printf child > {shlex.quote(str(child))}; exit {child_exit}']
            env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],'FAKE_MODEL':str(model_path)}
            result=subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=15)
            after=(paths['swapbase'].read_bytes(),paths['swapbase'].stat().st_mtime_ns) if paths['swapbase'].exists() else None
            model=json.loads(model_path.read_text())
            return {'rc':result.returncode,'output':result.stdout,'before':before,'after':after,
                    'child':child.exists(),'slot':paths['lock'].exists(),
                    'slot_owner':(paths['lock']/'owner').read_text() if (paths['lock']/'owner').exists() else None,
                    'model':model,'log':paths['log'].read_text() if paths['log'].exists() else '',
                    'residue':[p.name for p in root.glob('baseline.*')]}

    def refused(self, result):
        self.assertEqual(result['rc'],75,result['output'])
        self.assertFalse(result['child'],result['output'])
        self.assertEqual(result['before'],result['after'],result['output'])
        self.assertFalse(result['slot'])
        self.assertEqual(result['residue'],[])

    def test_success_exact_bounds_and_locked_revalidation(self):
        r=self.run_gate([{'used':3945,'pageouts':1000,'swapouts':2000,'swap_free':1024},
                         {'used':3929,'pageouts':1128,'swapouts':2128,'swap_free':1024},
                         {'used':3913,'pageouts':1256,'swapouts':2256,'swap_free':1024},
                         {'used':3913,'pageouts':1256,'swapouts':2256,'swap_free':1024}])
        self.assertEqual(r['rc'],0,r['output']);self.assertTrue(r['child']);self.assertEqual(r['after'][0],b'3913\n')
        self.assertIn('old=1812 new=3913',r['log']);self.assertIn('pageouts_delta=256 swapouts_delta=256',r['log'])
        self.assertLess(r['log'].index('SWAP_REPAIR'),r['log'].index('START'))
        tops=[x for x in r['model']['trace'] if x['command']=='top']
        self.assertEqual([x['time'] for x in tops],[100000,100030,100060,100060])
        self.assertTrue(all(x['slotExists'] for x in r['model']['trace']))
        self.assertFalse(r['slot']);self.assertEqual(r['residue'],[])

    def test_young_baseline_never_samples_or_changes(self):
        r=self.run_gate(age=1799);self.refused(r)
        self.assertEqual(r['model']['next'],1)
        self.assertFalse(any(x['command']=='sleep' for x in r['model']['trace']))

    def test_unreadable_or_future_baseline_age_refuses(self):
        for flags in [{'stat_fail':True},{'age':-1},{'baseline':'not-a-number\n'}]:
            with self.subTest(flags=flags):self.refused(self.run_gate(**flags))

    def test_tolerance_128_is_unchanged(self):
        r=self.run_gate([{'used':1940}],age=0)
        self.assertEqual(r['rc'],0,r['output']);self.assertTrue(r['child'])
        self.assertNotIn('SWAP_REPAIR',r['log'])
        self.refused(self.run_gate([{'used':1941}],age=0))

    def test_nonincreasing_raw_swap_not_truncated_integer(self):
        r=self.run_gate([{'used':3945.10},{'used':3945.11},{'used':3945.10}]);self.refused(r)
        self.assertIn('unstable swap sample 2',r['output'])

    def test_spread_just_above_32_refuses(self):
        r=self.run_gate([{'used':3945},{'used':3929},{'used':3912.99}]);self.refused(r)
        self.assertIn('unstable swap sample 3',r['output'])

    def test_paging_limits_each_across_whole_window(self):
        for field,start in [('pageouts',1000),('swapouts',2000)]:
            for middle,last in [(start+257,start+257),(start+128,start+257)]:
                with self.subTest(field=field,middle=middle):
                    r=self.run_gate([{field:start},{field:middle},{field:last}]);self.refused(r)
                    self.assertIn('paging activity/reset sample',r['output'])

    def test_counter_reset_even_when_final_delta_small(self):
        for field,start in [('pageouts',1000),('swapouts',2000)]:
            with self.subTest(field=field):
                r=self.run_gate([{field:start},{field:start+200},{field:start+100}]);self.refused(r)
                self.assertIn('paging activity/reset sample 3',r['output'])

    def test_free_swap_each_sample(self):
        for n in range(3):
            samples=[{}, {}, {}];samples[n]['swap_free']=1023.99
            with self.subTest(sample=n):
                r=self.run_gate(samples);self.refused(r)
                self.assertIn(f'repair sample {n+1} unreadable_or_free_swap_below_1024',r['output'])
                self.assertEqual(r['model']['next'],n+1)

    def test_all_normal_guards_each_sample(self):
        failures=[{'idle':39},{'available':4095},{'freepct':24},{'compressor':12289},
                  {'node':True},{'hold':'paused-for-owner'},{'swift':True}]
        for failure in failures:
            for n in range(3):
                samples=[{}, {}, {}];samples[n]=failure
                with self.subTest(failure=failure,sample=n):
                    r=self.run_gate(samples,minimum=6 if 'swift' in failure else 4);self.refused(r)
                    self.assertEqual(r['model']['next'],n+1)

    def test_normal_threshold_equality_and_minimum_scope(self):
        values={'idle':40,'available':4096,'freepct':25,'compressor':12288,'swift':True}
        r=self.run_gate([values]*4,minimum=4);self.assertEqual(r['rc'],0,r['output'])
        self.refused(self.run_gate([values]*4,minimum=6))
        self.assertEqual(self.run_gate([{'available':6144}]*4,minimum=6)['rc'],0)

    def test_unreadable_samples_are_not_zero_or_safe(self):
        failures=[{'malformed_top':True},{'malformed_swap':True},{'malformed_pressure':True},
                  {'omit_vm':['Pageouts']},{'omit_vm':['Swapouts']},{'omit_vm':['Pages purgeable']},
                  {'pageouts':1000.5},{'swapouts':-1},{'pageouts':1000000000000000},
                  {'fail_commands':['top']},{'fail_commands':['sysctl']},{'fail_commands':['ps']},
                  {'fail_commands':['vm_stat']},{'fail_commands':['memory_pressure']}]
        for failure in failures:
            for n in range(3):
                samples=[{}, {}, {}];samples[n]=failure
                with self.subTest(failure=failure,sample=n):
                    r=self.run_gate(samples);self.refused(r)
                    self.assertEqual(r['model']['next'],n+1)

    def test_postrepair_normal_revalidation_failure_rolls_back_bytes_and_mtime(self):
        for changed in [{'idle':39},{'used':4074},{'node':True},{'hold':'new-hold'},
                        {'malformed_swap':True},{'pageouts':999},{'swapouts':2257}]:
            with self.subTest(changed=changed):
                r=self.run_gate([{}, {}, {}, changed]);self.refused(r)
                self.assertIn('SWAP_REPAIR',r['log']);self.assertNotIn(' START ',r['log'])

    def test_normal_revalidation_retains_128_tolerance(self):
        r=self.run_gate([{}, {}, {}, {'used':4073}])
        self.assertEqual(r['rc'],0,r['output']);self.assertEqual(r['after'][0],b'4073\n')

    def test_interrupted_sampling_or_log_failure_never_changes_baseline(self):
        for flags in [{'sleep_fail':True},{'tee_fail':True}]:
            with self.subTest(flags=flags):self.refused(self.run_gate(**flags))

    def test_existing_slot_refuses_without_observation_or_owner_change(self):
        r=self.run_gate(slot=True);self.assertEqual(r['rc'],75);self.assertFalse(r['child'])
        self.assertEqual(r['before'],r['after']);self.assertTrue(r['slot']);self.assertEqual(r['slot_owner'],'other-real-owner')
        self.assertEqual(r['model']['trace'],[])

    def test_dry_run_is_advisory_even_on_success_or_stale_baseline_or_held_slot(self):
        for options in [{'samples':[{'used':1812}]},{},{'slot':True}]:
            with self.subTest(options=options):
                r=self.run_gate(dry=True,**options)
                self.assertFalse(r['child']);self.assertEqual(r['before'],r['after']);self.assertEqual(r['log'],'')
                self.assertEqual(r['slot'],options.get('slot',False));self.assertIn('DRY_RUN: advisory only',r['output'])
                self.assertEqual(r['rc'],0 if 'samples' in options else 75)
                self.assertEqual(r['model']['next'],1);self.assertFalse(any(x['command']=='sleep' for x in r['model']['trace']))

    def test_absent_baseline_normal_first_admission_is_preserved(self):
        r=self.run_gate(baseline=None)
        self.assertEqual(r['rc'],0,r['output']);self.assertTrue(r['child']);self.assertEqual(r['after'][0],b'3945\n')
        self.assertNotIn('SWAP_REPAIR',r['log'])

    def test_child_failure_is_not_repair_failure_after_normal_admission(self):
        r=self.run_gate(child_exit=7)
        self.assertEqual(r['rc'],7,r['output']);self.assertTrue(r['child']);self.assertEqual(r['after'][0],b'3945\n');self.assertFalse(r['slot'])


def mutants():
    changes=[('remove-nonincreasing','current <= previous && first-current <= 32','first-current <= 32','test_nonincreasing_raw_swap_not_truncated_integer'),
             ('relax-spread32-to33','first-current <= 32','first-current <= 33','test_spread_just_above_32_refuses'),
             ('relax-normal-tolerance128-to129','base+128','base+129','test_tolerance_128_is_unchanged')]
    all_killed=True
    for name,old,new,test in changes:
        with tempfile.TemporaryDirectory(prefix='gate-mutant-only-') as tmp:
            body=CANDIDATE.read_text();assert body.count(old)==1,(name,body.count(old))
            changed=body.replace(old,new);p=Path(tmp)/'mutant.zsh';p.write_text(changed)
            argv=[sys.executable,str(Path(__file__).resolve()),'--candidate',str(p),'GateTests.'+test,'-v']
            result=subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            print(json.dumps({'mutant':name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'command':argv,'exitCode':result.returncode,'killed':result.returncode==1}),flush=True)
            sys.stdout.buffer.write(result.stdout);sys.stdout.flush();all_killed &= result.returncode==1
    return 0 if all_killed else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(add_help=False);parser.add_argument('--candidate',type=Path,default=CANDIDATE);parser.add_argument('--mutants',action='store_true')
    args,remaining=parser.parse_known_args();CANDIDATE=args.candidate
    if args.mutants:raise SystemExit(mutants())
    unittest.main(argv=[sys.argv[0],*remaining])
