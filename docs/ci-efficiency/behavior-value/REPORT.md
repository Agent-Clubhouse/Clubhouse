# Which prompt-codec tests earn their runtime?

**Retain all five existing test groups. Strengthen the assertions for cursor mapping and literal fenced text.** In this local study, 55 codec tests detected four of the first seven faults. A rendering group that added no unique detection against those seven was the **only** group to detect an eighth fault. A user-visible range replacement also distinguished a broken editor from a passing low-level endpoint check.

The module turns Markdown into an editable ProseMirror document and back. Two consumers require different behavior. A stored composer draft must survive restore exactly. A sent message should still render lists and emphasis. Selection offsets also have to identify the right characters after Markdown markers disappear from the editable view. These are portable contracts with observable failures. The default-branch codec blob at assignment matched the previous study baseline. This extension changed tests and local audit tooling. [Previous CI study](../README.md) · [Matrix methods and execution receipts](README.md)

## What the tests detected

| Fault | Existing 55 codec cases | What supplied the distinguishing evidence |
|---|---|---|
| Disable exact draft restoration | Detected | Seven exact-mode cases caught it. Removing all seven let it survive. The independent historical replay also exercised remount and failed-send paths. |
| Enable exact mode by default | Detected | One normalization case distinguished sent rendering from draft restoration. The Markdown component had independent DOM failures. |
| Drop semantic emphasis when parsing | Detected | Only the normalized document property detected it at baseline. Source-byte round trips could still pass. A focused assertion now checks strong and italic meaning directly. |
| Shift cached source offsets by one | Survived | The existing endpoint check passed while replacing a slash token emitted `/compacto` instead of `/compact`. The new codec and editor checks independently capture the error. |
| Prefer the later equally near editor position | Survived | A raw API result differs. A fractional offset does not model a JavaScript text cursor. A later integer example demonstrates a tie, but no established user requirement chooses a side. Leave the behavior unspecified. |
| Increment ordered numbering before emitting the marker | Detected | Five baseline tests failed across multiple groups. No one group owned this fault. |
| Interpret emphasis inside a fenced literal | Survived | Restoring cached source could keep the Markdown bytes intact even though the document treated the text as formatted. A new check requires the literal asterisks and absence of emphasis marks. |
| Accept the first serialization of overlapping marks without checking the rendered text | Detected in a separate challenge | Eight of nine marks-group tests failed and the other 46 codec cases passed. For example, the displayed text became `**ab**c` instead of `abc`. |

The first seven were predeclared. The eighth was chosen **after** the marks group showed zero marginal detection and was run separately under the repository renderer configuration. It is evidence against deleting that group, not a held-out random sample. The earlier claim of six detected out of seven for the strengthened suite combines four measured baseline detections with two measured new ones. The final three codec assertions were directly exercised on five variants, including both green controls. No miss rate for production follows from these counts. [Crossing-mark receipt](crossing-receipt.json) · [Public editor replacement receipt](editor-receipt.json)

## Marginal detection and runtime

Each of the five groups was removed in isolation for the original, an equivalent control and each of seven faults. The 45 complementary executions checked the exact remaining test names. The timing ranges below are the sum of observed **test body** durations on the two green controls. They exclude jsdom/worker startup, setup and reporting. Running a new worker to omit a submillisecond test provides no demonstrated savings.

| Baseline group | Cases | Green test-body time | First-seven detections lost when the group was omitted |
|---|---:|---:|---|
| Source preservation | 34 | 7.2–7.8 ms | 0. One case also caught the numbering fault. |
| List/document structure | 4 | 61.0–72.5 ms | 2. Default-exact and dropped-marks each had only one detecting case. |
| Exact draft restoration | 7 | 0.4–0.5 ms | 1. All seven detected the same fallback fault on different inputs. |
| Crossing and adjacent marks | 9 | 72.1–77.1 ms | 0. This group alone detected the separate eighth fault. |
| Source/selection mapping | 1 | about 0.2 ms | 0. Its endpoint assertion missed the observed interior replacement defect. |

The 1,000-example crossing property took 76.4 ms in the original green run. Six targeted examples and an intraword case also detected the eighth fault. Their overlap makes the short examples good first diagnostics. It does not demonstrate that their narrow inputs replace the property. Conversely, the property is useful for breadth but has a less direct failure explanation. The seven exact-restore cases cost about half a millisecond together. Consolidating their fixture *setup* is reasonable if equivalence is shown, but deleting inputs offers no meaningful measured saving. [Per-test and complementary-run receipts](results.json)

**Two weak signals received stronger checks.** Mapping the end of a document to itself allowed two calculations to agree while the user's interior selection was wrong. We now check both the codec's selected substrings and the editor's emitted replacement using offsets taken directly from the input string. Checking just serialized Markdown allowed a cached string to hide lost semantics. We now inspect supported strong/italic meaning and fenced text with literal markers. The public editor test also checks adjacent text and rendered bold. Fixed numeric ProseMirror position arrays and tie-direction assertions were explored and excluded from the test patch because they would freeze implementation choices.

## Independent replay of a real bug

We used the product code immediately before and after the published composer fix. Both trees ran the **same fixed test and helper blobs**. Only the three production files in the historical diff changed. We ran six examples through the codec, through remount and the next keystroke, and through failed-send restore and the next keystroke. Four sent-Markdown DOM checks ran as negative controls.

| Historical product revision | Restore assertions | Sent-render controls | Deselected |
|---|---:|---:|---:|
| `ad5789182f348521a738d67a3d11f83a21b87a9c` | 18 failed | 4 passed | 54 |
| `c44e472952561e565ac78b7114e011e6f9a5e999` | 18 passed | 4 passed | 54 |

For example, the predecessor restored `1. a\n1. b` as `1. a\n2. b`. Six cases sharing an assertion do not mean six independent bugs. The evidence matters because three real entry points agreed on an observed text change, while the sent-render behavior stayed correct. This is a known historical case selected independently of synthetic fault generation. The local dependency overlay reused present tooling and pinned cached ProseMirror packages, so the exercise does not reproduce the historical CI machine. [Published fix](https://github.com/Agent-Clubhouse/Clubhouse/pull/3594) · [Source/test hashes, versions and observations](history-receipt.json)

## Consequences for selecting tests

The ten `PromptMarkdown` consumer cases detected only two of the first seven faults. Selecting just those tests would miss the exact-draft fault. Selecting just codec round trips would miss wiring failures between the editor handle, source offsets and `onChange`. For the already-sampled offset fault, the change in the emitted draft was observed through the real React editor with literal source offsets and a check on the preserved DOM. An original → fault → restored sequence gave pass → named assertion failure → pass. The unchanged codec endpoint control passed in all three. This makes the test valuable even if another new low-level test also kills that mutant.

The prior selector returns **full** on the actual #3594 before/fix diff on both Linux and Windows. No new eligibility rule is warranted. If prioritizing within a full run, execute the fast exact-mode and semantic assertions first, followed by editor remount, public replacement and sent-render checks, then both seeded properties. Keep undo/IME, real browser selection, provider/transport and native-platform coverage separate. These local jsdom observations cannot establish those behaviors or any hosted wall-clock gain.

## Cost, validity and repeat use

- The producer matrix used 88 of a 90-subprocess budget. Eighty-six produced observations and two stopped in dependency setup before executing assertions. The eighth fault used the remaining two slots (original and challenge) and about 1.33 additional seconds. Together the matrix and challenge used about **63.3 seconds** against a 180-second cap, with one worker. The equivalent initialization control kept its green results. No timeout, compilation error, crash or zero-test run was credited as useful detection.
- The separate historical replay used two valid processes and two invalid setup attempts while staging the historical global-setup script. The editor probe used three processes for the final evidence and three earlier checks while refining the assertion to show the actual emitted text. Each probe had a 30-second per-process cap. All production variants lived in temporary source trees. The assertion messages describe deterministic synthetic drafts.
- The original matrix archived test identities, exit codes and assertion messages but omitted some global suite/error counters. All 38 failing executions had exit 1 and recorded named assertion failures. This supports the observed assertions. It cannot certify that the runner captured every simultaneous infrastructure failure. Treat missing counters as unknown. Green original/equivalent controls, deterministic seeds and selected reruns address some noise; two local timings do not measure a flake rate or OS independence.
- Repeat a small audit when a serializer, public selection contract, fixture generator or known regression changes. Rotate faults across the costliest groups, include an opposite-mode green control and a real consumer, and keep an independently sourced historical case. Strengthen a test when an obtainable user-visible defect survives it. Consider consolidation only after multiple distinct fault families, consumer boundaries and measured runtime show the same detection. Exclude unspecified behavior from promotion decisions and keep the full suites authoritative.

Reproduction commands and the complete primary receipts are in the [experiment notes](README.md). With existing dependencies set `CODEC_NODE_MODULES` to their directory and run `history_replay.py`, `editor_probe.py` and `crossing_probe.py` using Python. These read pinned local Git objects and remove temporary copies on exit. Reproduction writes new timing receipts, so use a separate checkout to retain the published observations.
