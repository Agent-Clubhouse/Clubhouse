# Independent QA: desktop test gate, stale swap baseline (source and policy review)

Reviewer: qa-details-local-composition, November 21, 2026.

- **Inputs:** Q5 evidence `4b34cce9a`, which is in `q5-ledger-evidence`, at `root-state-224e0797d/resource-observation/`. The gate source sha256 is `61797476…cf16`, and I recomputed it.
- **Method:** a read-only review. Nothing was edited, reset or retried.

## Finding: the swap guard has become a permanent refusal, not a measurement

- **How the guard works:** `SWAPBASE` (`/tmp/clubhouse-desktop-test.swapbase`) is written **only** when a run is admitted. It has no age, expiry or requalification. The predicate is `swap_used > base + 128`.
- **The situation:** the baseline is 1,812 MiB, written at 13:17:49Z by the last admitted run, which ended at 13:17:50Z. Swap is now 3,945 MiB and stable. Every other guard passes with a wide margin:
  - CPU idle 84% (the minimum is 40%);
  - available memory 33,209 MiB (the minimum is 4,096);
  - kernel free memory 87% (the minimum is 25%);
  - compressor 1,128 MiB (the maximum is 12,288);
  - no slot or hold, and no node, Swift or Xcode load.
- **Why it can't recover:** macOS rarely returns used swap to its earlier level without a reboot. Admission is the only thing that rewrites the baseline, and swap is the only thing blocking admission, so the gate can't recover by itself.
- **What the guard is for:** the code comment says "swap not grown since the last admission". It's meant to detect **recent** pressure. An absolute value from five hours ago no longer measures recent pressure; it's a ratchet. Refusing forever on a quiet host is a **liveness defect**, not added safety.
- **Repair versus forcing admission:**
  - **Legitimate repair** re-establishes what "recent" means with fresh, bounded, stable observations, and keeps every threshold.
  - **Forcing admission** would mean raising the 128 MiB tolerance, deleting or hand-editing the baseline, adding a bypass, or lowering other guards. All of that stays forbidden.
- **The owner's README is right** to forbid a manual reset. A rule written into the script is the reviewable alternative.
- **Minor:** the header comment says the compressor limit is 8 GB, while the code uses 12 GiB. Fix the comment, and don't change the threshold.

## Proposed minimal requalification rule (for review; not applied)

**Trigger:** only when the **only** failing predicate is `swap_grew`, and the baseline file's mtime is at least 30 minutes old.

**Fresh observations:** take K = 3 samples, 30 s apart, about 60 s in total, inside the gate run while it holds the slot. In **every** sample:

- every existing guard passes unchanged: idle at least 40, available at least the requested minimum, free percentage at least 25, compressor at most 12 GiB, no explicit hold, no heavy compile hold, no other vitest or tsc;
- swap is stable: at most 32 MiB between the highest and lowest sample, and not increasing from first to last;
- there's no active paging: `vm_stat` Pageouts and Swapouts deltas across the window stay at or below a small bound (for example 256 pages);
- **new and stricter:** free swap from `vm.swapusage` is at least 1,024 MiB. It's 1,174 MiB now, so a host close to swap exhaustion is never requalified.

**If every sample passes:**

1. Append `REQUALIFIED base old->new samples=[…] pageouts_delta=… swapouts_delta=…` to the gate log.
2. Write the new baseline equal to the current swap.
3. Re-run the **normal** predicate set unchanged, and admit only if it passes.

**If any sample fails:** refuse with `swap_grew(requalification failed: <reason>)`, without touching the baseline.

**Unchanged:** the single slot, explicit and allow holds, the Go compile hold, the other-test detection, all thresholds, the 128 MiB tolerance, the caller's 60 s and 30 min retry policy, and baseline writing on normal admission.

**Determinism and testability:** add a `--dry-run` that prints the full decision and the samples without taking the slot or running anything. Optionally, a test-only sampler override, through an env var honoured only by a separate test copy.

## Authority and process

- This is a **shared-resource policy change**. The gate script belongs to the orchestrator and gate owner, not to Q5, the lane or QA.
- It needs:
  1. explicit owner approval of the rule above, or a stricter variant;
  2. one reviewed diff of the script;
  3. independent QA of that exact diff.
- **QA controls for the diff:**
  - a stale baseline with a quiet host and stable swap requalifies and logs;
  - a stale baseline with swap still increasing, or with pageouts, refuses;
  - a fresh baseline (under 30 min) refuses as it does today;
  - another failing predicate (idle, available, free percentage, compressor, hold, other test) never reaches requalification;
  - free swap under 1 GiB refuses;
  - normal admission still rewrites the baseline;
  - a mutant with a raised tolerance or no stability check must fail the review.
- Until approved, **keep refusing**, and record NOT RUN as policy requires. Nobody resets, bypasses or kills anything.

## Verdict

- The stale baseline is a **real liveness defect** in the gate, not a safety signal.
- The fix above restores the meaning "swap grown since a recent, verified quiet baseline" without lowering any threshold.
- It requires gate-owner approval and exact diff review. QA grants no waiver or admission.
