# 8 — Wire one counter that exists; settle one that never fires

Two defects, both already documented in this repository, both cheap next to their
value. Neither is a new idea; both are promises the codebase made and did not keep.

---

## Part A — `blockedStreak` is built and unread

### The failure

`goal.json` carries three fields for blocked-goal hysteresis
(`src/lib/goals.js:254-256`): `blockedStreak`, `lastBlocker`, and a
`blockedThreshold` of 3. `karpathy-report.md:154-160` reports that **nothing reads
or increments any of them**, and names it precisely:

> the exact flaw `best-goal-report.md` line 78 convicts Codex of … reproduced here
> with the counter already built and left unwired.

The intent came from Codex, which requires a goal to be judged blocked on **3
consecutive turns** before it gives up (`best-goal-report.md:131-132`, citing
`continuation.md:43-49`). The reasoning is sound: "blocked" is a claim about the
environment, and a single turn's assessment of it is weak — a service that was
down may be up, a credential the model could not find may be in a file it had not
read.

What exists instead is a different, cruder mechanism: `goals.blockedOut`
(`src/lib/goals.js:346`) gives up once `blockedStreak >= blockerLimit` (default 2,
`src/lib/goals.js:60`), and `blockedStreak` is incremented **only** by
`goals.addBlocker` (`:308`) — i.e. only when the *model* runs
`bandaid goal block`. So the counter tracks how many distinct things the model said
were blocked, not how many consecutive turns the goal has been stuck. Those are
different quantities and the field name describes the second.

### What to do

Two candidate readings, and the brief must choose one deliberately rather than
implement both:

1. **Rename to match reality.** `blockedStreak` → `blockerCount`, drop
   `blockedThreshold`, and the current behaviour is correctly described. Zero
   behaviour change. Honest, cheap, and closes the report's complaint by admitting
   the counter is not what it was named.
2. **Wire the consecutive-turn semantics.** Increment on each consecutive Stop
   where the assessment says blocked and nothing progressed; reset on any progress
   signal (brief 7 supplies exactly this). Give up at 3.

**Choose (2), and keep the existing count under its correct name.** They measure
different things and both are useful: "the model has named 2 distinct blockers"
and "this goal has been stuck for 3 rounds running" are separately actionable, and
collapsing them is how the field got confusing in the first place. So:
`blockerCount` (renamed, existing behaviour, existing `blockerLimit`) and
`blockedStreak` (new, consecutive, `blockedThreshold: 3`).

Reset semantics are the part to get right. A streak resets on a progress signal —
which is brief 7's `src/lib/progress.js`, and is why this brief is sequenced after
it. Without a progress signal, "consecutive" degrades to "consecutive turns where
the model did not run `goal block` again", which is not the thing being counted.

Migration: a `goal.json` written before this change has `blockedStreak` holding the
old semantics. `goals.loadGoal` maps it to `blockerCount` on read when
`blockerCount` is absent, and starts `blockedStreak` at 0. One branch, tested.

---

## Part B — the plateau breaker provably never fires

### The failure

`goals.plateauReached` (`src/lib/goals.js:290`) gives up when the same
verification failure repeats. `goals.recordReason` (`:284`) counts consecutive
identical reasons after `normalizeReason` (`:268`) lowercases and collapses
whitespace, deliberately keeping digits significant so *"3 tests failing"* and
*"1 test failing"* are different — a good decision, since that difference is
progress.

`README.md:707-716` then reports what happened when it was replayed against
reality:

> Replayed against two real stuck loops of 7 and 4 consecutive blocks — 9
> consecutive pairs, every one of them a judge repeating itself in substance —
> **not one pair was byte-identical, so it would have fired zero times.** … token
> overlap between consecutive reasons sat around 0.2–0.7 depending on how much of
> the reason you compare, so there is no threshold that separates "stuck" from
> "progressing" either.

So: a mechanism that has never fired, whose replacement was investigated and found
to have no workable threshold, kept because it is a *"cheap backstop for the
check-command case, where the same output really does repeat verbatim."*

That last clause is the one defensible claim for keeping it, and it has never been
measured either.

### What to do

Brief 9's harness can produce a stuck loop on demand — that is one of the fixtures
it exists to run. So this is finally decidable, and there are exactly three
honest outcomes:

1. **It fires on the check-command fixture.** The narrow claim holds. Keep it,
   document it as check-command-only in as many words, and stop implying it covers
   the judge case.
2. **It never fires even there.** Delete it. `plateau`, `lastReason`,
   `normalizeReason`, `recordReason`, `plateauReached`, `plateauLimit`, and the
   branch at `src/hooks/stop.js:177-181` all go, along with the tests that assert
   a mechanism nobody reaches. `README.md`'s paragraph about it becomes a line in
   the changelog.
3. **It fires but so does brief 7's stall detection, earlier and on more cases.**
   Then it is redundant rather than broken, and it still goes — brief 7's stall
   rule ("two rounds with no progress signal") is strictly more general than
   "two identical strings", needs no similarity metric, and covers the judge case
   the plateau breaker cannot.

Outcome 3 is the likely one, and it is worth predicting in advance so the result
is a measurement rather than a rationalisation. `README.md:849-851` sets the
standard: *"a mechanism whose ablation moves no number is a mechanism to delete,
and saying so in advance is what makes deleting it a result rather than a defeat."*

**Deleting it is the expected outcome and is a success condition of this brief, not
a failure of it.**

What must not happen: replacing it with a token-overlap similarity metric. That was
investigated, the numbers are published (0.2–0.7 with no separating threshold), and
re-litigating it without new data would be adding a mechanism on a hunch in the one
repository that has explicitly forbidden that (`karpathy-report.md:242`).

---

## Part C — one stale comment

`src/lib/install.js:22-25` says a test asserts that `HOOK_EVENTS` and
`hooks/hooks.json` agree, and names `test/install.test.js`. That file does not
exist. The assertion is real — it lives in `test/hooks.e2e.test.js:359`, *"the
plugin manifest and the installer agree on every event and timeout"*, alongside
`:376`'s check that the Stop hook gets more time than the verifier it runs.

One line, pointed at the right file, fixed in passing. It is in this brief rather
than its own because a comment that lies about its test is the same class of defect
as a counter that lies about its semantics, and both are found by reading rather
than by running.

---

## Settled, as built — and both halves came out backwards

### Part A: the premise was stale. Nothing was wired, because nothing needed wiring.

`karpathy-report.md:154-160` says `blockedStreak`, `lastBlocker` and
`blockedThreshold: 3` exist and "nothing reads or increments any of them". Checked
against the current tree:

- `blockedStreak` **is incremented**, by `addBlocker` (`src/lib/goals.js:402`).
- It **is read**, by `blockedOut` (`:409`), against `blockerLimit`.
- `blockedThreshold` **does not exist anywhere** — not in `src/`, `bin/` or `test/`.
  `blockerLimit: 2` is the live knob.

The report was measured against a tree with 87 tests; there are now 491. The
counter was wired somewhere in between and the report's entry went stale.

So this brief does **not** add the consecutive-turn streak it planned to. That would
be a second counter for a problem that no longer exists, which is a mechanism with
no measurement behind it — the one thing this repository forbids. What ships instead
is two tests that pin the wiring, so the report's claim cannot quietly become true
again, and a note that the `checkFailing` suppression at `src/hooks/stop.js:165-171`
still holds: a red check is unfinished work with a blocker attached, not a blocked
goal.

### Part B: the plateau breaker was not dead. It was firing too eagerly, on a bug.

Brief 8 predicted outcome 3 — that the plateau breaker was redundant because brief
7's stall rule "fires earlier and on more cases". `npm run loop` says the reverse:

```
  ended by   check 2 · complete 0 · stall 0 · plateau 3 · blocker 1 · budget 0
  DEAD       stall  — a fixture aims at it and it never fires
```

**Plateau ends three of the four stuck loops. The stall rule ends none**, because
`plateauReached` is checked at `src/hooks/stop.js:242` and `progress.settle` at
`:262`, so plateau reaches its limit a round earlier every time.

And the reason plateau looked dead in the README was a one-line bug, found by the
harness and fixed in brief 9: the failure reason carried only the *command*, so the
comparison was a constant against itself. That made it fire after any two
consecutive failing check rounds — **killing a loop that was visibly converging**,
demonstrated by the `slow-converging` fixture being terminated at round 3 before it
could finish at round 4.

**Decision: keep it, and rewrite what the README says about it.** It now compares
what it was always documented to compare. The README entry claiming it "would have
fired zero times" is replaced with both halves of the truth — the judge-graded replay
that produced that figure is still correct and still unaddressed, and the
check-graded case was firing far too often for a reason nobody had measured.

No similarity metric was added. That was investigated, the numbers are published
(0.2–0.7 overlap, no separating threshold), and re-litigating it without new data
would be exactly the guessing this repo forbids.

### Part C: the stale comment

`src/lib/install.js:22-25` named `test/install.test.js`, which does not exist and
never has. The assertion is real and lives in `test/hooks.e2e.test.js:359`. Comment
corrected, and it now says what the old one got wrong.

## Tests

| Test | Asserts |
|---|---|
| `test/goals.test.js` | `blockerCount` preserves today's `addBlocker` behaviour under the new name; `blockedOut` still fires at `blockerLimit` |
| | `blockedStreak` increments on consecutive blocked-with-no-progress stops and **resets on a progress signal**; gives up at `blockedThreshold: 3` |
| | Migration: a goal record with only the old `blockedStreak` loads with `blockerCount` set and `blockedStreak` at 0 |
| | Interaction with `src/hooks/stop.js:165-171`: a *failing check command* still outranks a blocked verdict, so a goal with a red check is unfinished work with a blocker, not a blocked goal. This is existing behaviour and must survive the rename |
| `test/goals.test.js` (part B) | Whichever outcome lands: if kept, a check-command fixture with byte-identical output fires it; if deleted, the tests asserting it go with it and nothing else changes |
| `test/hooks.e2e.test.js` | The manifest/installer agreement test is untouched; the comment now names it correctly |

The `checkFailing` interaction is the one easy thing to break here. `stop.js:165-167`
deliberately suppresses `blockedOut` while a configured check is failing, with a
comment explaining why. A rename that misses that call site turns a red test suite
into a blocked goal.

## Measurement

Part A: brief 9's harness on a fixture where the environment genuinely cannot
supply something. Does the goal give up after 3 consecutive blocked rounds rather
than after the model has named 2 things? Report rounds-to-give-up before and after.

Part B: brief 9's harness on the non-converging fixture, with a check command whose
output is byte-identical every round, and with a judge whose prose varies. Report
whether the plateau breaker fires in either case, and whether brief 7's stall rule
fires first. Then keep or delete on that number.

Part C: no measurement. It is a comment.

## Honest limits (to be added to the README)

- **`blockedStreak` and `blockerCount` are two different counters** with two
  different thresholds, and a goal can end via either. That is more surface than a
  single number, and the reason is that the two conditions — "several distinct
  things are blocked" and "this has been stuck for three rounds" — genuinely differ.
- **The streak resets on brief 7's progress signal**, so it inherits that signal's
  limits: a goal with no check and no probes has few ways to earn a reset, and will
  reach the threshold faster. That errs toward giving up early on unverified goals,
  which is the safe direction but will occasionally abandon real work.
- If part B ends in deletion: **there is no longer any repeated-failure detector
  distinct from the stall rule.** The stall rule covers the judge case the plateau
  breaker never could, and the check-command case it was kept for turned out to
  be — whatever the number says. State the number.

## Files touched

`src/lib/goals.js` · `src/hooks/stop.js` · `src/lib/config.js` ·
`src/lib/install.js` (one comment) · `bin/bandaid.js` (`status` and `goal show`
display both counters) · `README.md` · `test/goals.test.js` ·
`test/hooks.e2e.test.js` · possibly the deletion of `plateau` throughout
