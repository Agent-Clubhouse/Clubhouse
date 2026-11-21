# R1 narrow memory-unit successor — not active

Source auto-reset-policy-design/desktop-gate-memory-units-r1
@274a39410c714931abfd38369d53b9101d5b60c5,
tree e3ae0e77c55a1da6017ed3f85129e8a64bac85b6.
Candidate SHA256 d45cbfb0449abc1ce34bbc84960292dca70e6b551944beb9109b79d11fe9a7d3.
Prior4be/5a6 branches/commits/evidence remain unchanged. Original61797476
is still byte-exact and live unchanged. QAad85eff98's repair logic approval
and required R1 are retained; this requests narrow successor readback only.

Candidate diff from4be changes ONLY memory conversion, diagnostic unused
fallback and removal from mandatory fields. Existing128 tolerance,3-sample
window/counters/free-swap/normal revalidation/rollback/holds/dryrun untouched.
See candidate-from-4be.patch and source-bridge.json. Full diff to original
remains source gate.patch. README adds corrupt-baseline inspection/noauto-reset
and explicit conversion semantics. No source or live schema/default changes.

## R1 semantics

Exactly one nonnegative decimal B/K/M/G/T token, binary scale toMiB, with
CEILING for pressure guard (rather than flooring away over-limit pressure).
0B→0,512K→1,1G→1024,1T→1048576; exactly12GiB→12288pass,
12GiB+1B→12289refuse. Low positiveB/K rounding up is harmless at12GiB
and deliberately conservative. No precision that top did not print is inferred.
Unknown/nonfinite/multiple/absurd compressor tokens refuse; never default0.

Top unused token is diagnostic only; VM availability remains the guard. Valid
raw B/K/M/G/T logs as-is; absent/invalid logs unknown, without refusal.
Corrupt existing SWAPBASE stays failclosed and requires owner inspection,
recorded preservation/decision under normal explicit controls, no automatic
reset/delete/mtime rewrite or fabricated first-admission treatment.

## Exact executed narrow evidence

Seven SELECTED unittest methods PASS44.271s, command/exit0/raw retained:
unit boundaries (including0B/512K and one-byte/fraction above12GiB forB/K/M/G/T);
full repair window withB/K compressor and unusedK/B; unknown/missing unused
fallback; unparseable compressor at each of4stages incl post-repair rollback;
exact locked-window success; normal threshold equality; advisory-only dryrun.
No unselected old tests or counts are claimed on this successor.

One additional floor-pressure mutant is killed: targeted unit-boundary test
exits1 with FIVE behavioral failures because fractional-overlimit values
actually admitted the fake child. Aggregate mutation driver exits0 for the
expected kill. Raw output/commands/SHA are retained. Mutant reconstruction
bytes match the recorded executed SHA; removed temp original is not claimed
to have been retained. Old three stability/tolerance mutants remain attributed
only to4be/5a6, not rerun or transferred.

Both commands use project-owner-authorized LIGHT fake-resource simulations,
not live gate/admission or heavy tests. Private rewritten paths, fake time and
sentinel shell only. Exact before/after clean head/tree/five source hashes/
sealer match; live gate hash and baseline byte-hash/mtime unchanged for both.
No package/dependency changes, real top probes, real stability sampling,
activation, baseline reset, current-resource dryrun or root/P1 checks.

Await independent successor QA AND parent activation confirmation. Any later
authorized activation must preserve mode/backup, verify original617/livebase
bytes/mtime/no active slot-child, atomic same-directory replacement/hash, one
advisory dryrun with unchanged baseline, then observe first normal admission.
NONE of those activation steps has been executed by this R1 work.
