# Exact71 entry arbitration mutation controls

Independent review26f30282af2779f6693fa555b17ff06e3ac914ae approved the
journal-local71bd source/evidence, recommending executed red controls for
synchronous placement and the second-handle check before citing them as proven.
This supplement changes no implementation source or previous evidence.

Both admitted runs checked out exact clean source
`71bd4d632e58161400d086fa2305ce45580cad60`, tree
`95d0c8e07d3ca08d7b0626942b9a498118dd0d28`.
Its journal SHA256 remained
`e0be83586d17de93b1a4274c428bf19072ed618d4b48df84cccdf59ebfc26ec7`.
The existing sealed wrapper binds its original22 source hashes before/after.

## Fixture attribution

To keep the implementation checkout exactly71, the fixture was frozen on
separate pushed branch `auto-reset-policy-design/q5-entry-mutation-controls`,
then copied byte-for-byte outside that checkout. The external fixture is not
one of the wrapper's22 hashes. Its own before/after hashes are embedded in raw
output and independently matched to the following frozen Git blobs; unchanged
originals and copies are preserved here, not retro-added to the old seal.

| Fixture head | SHA256 | Observed result |
| --- | --- | --- |
| a645c67e80ddc8ac4ade15a34d3df30d1ccef570 | 2c72d4775a2220e9b28a7c2d31b0c42d345eb5cc12971e7be5decb338e67b222 | attempt1 exits1: placement target ambiguous before compile |
| 47cf671ef5d4a7442a21fdf8b9b8a5c272eced6e | 893441bbd623e0876bd3b4d590788e2706d9767b22582cf00389550e29b2706e | attempt2 exits0: control and both mutants behave as expected |

The first target matched both settlement and checkpoint queue declarations.
It refused rather than applying an ambiguous mutation. The corrected fixture
anchors the full private enqueue signature; it changes only that experimental
target. No production-source edit/restoration was needed: all mutations occur
in memory during ES2020/CommonJS transpile-only compilation of the actual source.

## Actual narrow results, attempt2

Three isolated child processes run sequentially with synthetic recipients and
temporary files. Each tests two handles for the same attempt and immediate
entry after uncertain/recover requests, deliberately before awaiting anything.

| Mode | Child exit | Actual behavior |
| --- | --- | --- |
| guarded | 0 | duplicate handle, immediate uncertain entry and immediate recover entry all refused |
| queued-only-hold | 2 | duplicate handle refused; uncertain and recover immediate entry both admitted, safety assertions failed |
| remove-attempt-entry-check | 2 | duplicate handle entered, safety assertion failed; both immediate transition controls still refused |

The first mutant removes the synchronous increments and adds those same hold
increments at the start of the queued callback. Existing hold release remains
in place. The second removes only the entered-set condition on mark, preserving
the capture, proof, status and other gates. Mutated-source hashes are printed
before transpilation. The runner requires the exact expected statuses and
specific assertion messages; syntax/load failures do not count as killed mutants.

Attempt1 also observed guarded0 and duplicate-check mutant2, but placement
mutant1 never compiled and earns no placement proof. All original output is
retained. Attempt2 guarded0 versus mutant2/2 demonstrates these behavioral
controls distinguish the specified guard removals; it is no proof of every
possible race or runtime integration.

Both commands were admitted min4 inside desktop-test-gate, with equal clean
exact71 head/tree/source receipts, raw hashes and gate outputs. No resource
refusals, broad reruns, provider calls, app runtime, installs or activation.
Manifest now indexes38 receipts with prior36 unchanged. Dependency linkage
used the matched worktree-only layout and original node_modules is restored.
Evidence branch/head is packaging, not the executed implementation head.
Shared generation, sparse authoritative roots, R1 activation, migration,
runtime/UI/platform/product gates remain independent.
