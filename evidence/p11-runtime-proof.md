# p11 runtime proof — what was and was not verified

Machine values live in `p11-runtime-proof.json`. This file carries the prose, because the privacy
guard constrains JSON strings to short enum/count/timing values — free text in a data file is the
hole a pasted tracker summary would come through.

## Verified at runtime

- `radar work` renders WorkRefs folded by default, showing the tracker's native status *and*
  radar's canonical projection side by side, so the projection can never be mistaken for the
  source of truth.
- `radar work --selectable` filters to actionable items only.
- `radar route <urn>` prints the resolved target, or `none` with the reason that explains it.
  A null route always names its cause; "unresolved" alone would be a shrug.
- An unknown urn exits 2 rather than rendering an empty success.
- Both commands run standalone against a snapshot, with no server and no scan.

## Not verified, and why

A live dispatch was **not** performed. It is blocked on the two-leader topology (E-001): a second
collector reports `role: leader` while seeing zero repos, and routing against a session inventory
this process cannot reach is exactly the condition the dispatcher now refuses. Fixing that means
changing live topology on a running machine, which was explicitly out of scope for this build.

The dispatcher's refusal path for that condition **is** covered by fixture tests.

## Redaction rule

Everything in this directory is counts-only or structurally redacted. No titles, assignees, issue
URLs, absolute paths, machine names, real project keys, branch names or session ids.
`test/radar-p11-privacy.test.js` enforces it and fails the build rather than warning.
