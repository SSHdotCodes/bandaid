# 7 — Progress-conditioned continuations: earn the leash

## The failure

The continuation cap is a flat number chosen by verifier strength
(`src/lib/goals.js:47`):

```js
const DEFAULT_CONTINUATIONS = { verified: 8, judged: 4, unverified: 2 };
```

That is already better than one number — `README.md:138-141` argues it well: *"two
rounds is generous for a goal nothing can check, and miserly for one that a shell
command closes the moment it exits 0."*

But it is still flat *within* a tier, and on a large task that is wrong in both
directions at once. A goal making steady, verified progress hits 8 and stops
mid-refactor. A goal spinning on the same failure burns all 8 doing it. The number
describes the *verifier*, and says nothing about whether this particular loop is
converging.

This is the brief that most directly serves *"work on larger tasks without stopping"*.

## The principle it comes from

`karpathy-report.md` §1.4, the autonomy slider: autonomy should be **earned** as
the verifier proves out. The tier map already applies that across tiers. This
brief applies it across *rounds*, which is where a long task actually lives.

Codex, for comparison, has **no iteration cap at all**
(`best-goal-report.md`, citing `core/src/session/turn.rs:394`) — its default
configuration is an unbounded loop. That is the failure at the other end, and this
brief must not drift toward it. The deliverable is a leash that lengthens on
evidence, not one that disappears.

## The mechanism

```
budget starts at the tier value (8 / 4 / 2)

each continuation:
  progress?  → refund 1   (net cost 0)
  stall?     → spend 2    (net cost 2)
  neither?   → spend 1    (today's behaviour)

hard ceiling: 3 × tier value, never exceeded
also bounded by: goals.timeBudgetMs (brief 1), tokenBudget, blockedOut, plateau
```

Three properties this shape has and simpler shapes do not:

- **A converging loop is effectively unbounded until the clock stops it.** Which is
  correct: if every round moves a criterion, the reason to stop is time or tokens,
  not a round count.
- **A stalling loop dies faster than today.** Spending 2 on a stall means an
  unverified goal that achieves nothing gets one round, not two. The feature makes
  the bad case *better*, which is what makes it safe to ship on by default.
- **The worst case is finite and small.** 3× the tier value, and the wall-clock
  budget cuts across it. `README.md:134` currently promises *"worst case is two
  extra rounds on a goal the model cannot finish"*; that sentence has to be
  rewritten, honestly, to name the new worst case.

## The hard part: a progress metric that cannot be gamed by touching a file

This is the whole brief. A refund is a reward, and any reward computed from
something the model controls will be optimised rather than earned. `turnWasTrivial`
(`src/lib/goals.js:387`) is not sufficient — it returns false for *any* call to
`Bash`/`Edit`/`Write`/`Task`, so a `touch` earns a refund.

Signals, ordered by how hard they are to fake:

| Signal | Source | Gameable? |
|---|---|---|
| A criterion moved from uncovered/claimed-only to **covered** | `evidence.coverage` (`src/lib/evidence.js:128`) | Hard — coverage requires a `check`, `probe`, `judge` or `expect` record, and `evidence.append` forces model-supplied records to `unverified` (`:79`) |
| The **check command's output changed** while still failing | `verify.runCheck` (`src/lib/verify.js:56`) | Hard — a different failure is a different state. "3 tests failing" → "1 test failing" is exactly the case `src/lib/goals.js:266` already reasons about |
| A check that was failing now **passes** | `verify.assess` | Not gameable; it closes the goal outright |
| A **task completed** | brief 3's ledger | Gameable — the model writes its own todo list. Counts for at most 1 refund per goal, and only alongside another signal |
| Worktree fingerprint moved | `stamp.worktreeStamp` (`src/lib/stamp.js`) | Trivially gameable. **Not used.** |

The rule: **a refund requires a signal from the first three rows.** A completed
task alone is not progress; it is the model's account of progress, and this
repository's entire posture is that the model's account is a lead, not a finding
(`README.md:838` — *"a lead to follow, never a finding to accept"*).

A stall is the negation *plus* evidence of repetition: no signal from rows 1–3 and
the verification reason is substantively the reason from last round. That second
clause is brief 8's territory — the current plateau detector compares reasons for
byte-equality and provably never fires (`README.md:707-716`) — so until brief 8
settles it, **a stall is defined as "no progress signal for two consecutive
rounds"**, which is measurable today and needs no similarity metric.

## What gets recorded

Added to `goal.json`, so the decision is auditable rather than inferred:

```jsonc
{
  "continuations": 6,
  "maxContinuations": 8,
  "refunded": 3,
  "ceiling": 24,
  "progressAt": ["…", "…"],
  "lastProgressSignal": "criterion-covered:2"
}
```

`lastProgressSignal` names *which* signal fired. Without it, a wrong refund is
invisible, and this mechanism has to be debuggable by reading a file — brief 9's
harness will need exactly this field to explain a run.

Brief 1's `lastProgressAt` gets its real definition here, replacing the deliberately
weak "any non-trivial turn" placeholder that brief 1 documents as a placeholder.

## The render

One clause on brief 5's capacity line, and only when a refund has happened:

```
Capacity: continuation 6/8 (3 earned) · 3h18m of 6h
```

`(3 earned)` is worth its three words: it tells the model the loop is being
extended because the work is moving, which is information about its own situation
that nothing else conveys. If brief 10's ablation says otherwise, it goes.

## Implementation

`goals.decideOnStop` (`src/lib/goals.js:510`) is a pure function and must stay one.
It currently receives `{ goal, config, stopHookActive, recentBatches,
lastAssistantMessage }`. It gains a `progress` argument — a value computed by the
*caller*, not by `decideOnStop` itself, because computing it requires reading the
evidence ledger and running the worktree stamp, and a pure decision function must
not do I/O.

`src/hooks/stop.js` computes it. The ordering there is delicate: `verify.assess`
already runs before the block (`src/hooks/stop.js:104`) and produces the check
output and the evidence records the progress signal needs, so the computation slots
in after `assess` and before `recordReason` (`:173`). The refund is applied to the
saved goal at `:183-187`, where `continuations` is already incremented.

`resolveMaxContinuations` (`src/lib/goals.js:85`) keeps its current behaviour
exactly: a scalar `config.goals.maxContinuations` still overrides everything, and
when a user has set a scalar the refund mechanism respects it as the base and the
ceiling becomes 3× that. Somebody who set `maxContinuations: 1` meant it.

## Tests

| Test | Asserts |
|---|---|
| `test/goals.test.js` | Refund on a row 1–3 signal; no refund on a completed task alone; no refund on a moved worktree fingerprint; two consecutive no-signal rounds count as a stall and spend 2 |
| | The ceiling: a goal refunded 40 times stops at 3× tier. This is the loop-safety test and it is the important one |
| | A scalar `maxContinuations` is honoured as the base; `maxContinuations: 1` never becomes 2 |
| | Interaction: an exhausted wall-clock budget (brief 1) wins over an available refunded continuation |
| new `test/progress.test.js` | The progress computation over hand-built evidence ledgers: uncovered→covered fires; claimed-only→claimed-only does not; a changed-but-still-failing check fires; identical check output does not |
| `test/hooks.e2e.test.js` | A seeded goal whose check output changes between two runs gets a refund visible in `goal.json`; one whose output is identical does not |

## Measurement

This brief cannot be honestly measured by `npm test`, and that is the reason brief
9 exists. On brief 9's harness, against the flat cap as control:

| Figure | Why it decides |
|---|---|
| **Rounds to completion** on fixtures that *can* be completed | The feature's whole claim. If it does not reduce this, it does nothing |
| **False-close rate** | The expensive error. Must not rise. A longer leash that closes unfinished goals is a regression whatever it does to the first number |
| **Rounds wasted on unfinishable fixtures** | Must *fall* versus the flat cap, because a stall spends 2. If it rises, the stall detection is not working |
| **Refunds per goal, and which signal fired** | Diagnostic. If one signal accounts for every refund, the others are dead weight and go |

Ship gate: rounds-to-completion falls, false-close rate does not rise, wasted
rounds do not rise. Three conditions, and failing any one means the mechanism
does not ship — most likely by tightening what counts as progress rather than by
abandoning the idea.

## Measured, as built

**What is asserted, end to end.** Two `stop.js` runs against a real check command:

```
round 1: check says "3 tests failing"  → continuations 1, refunded 0
round 2: check says "1 test failing"   → continuations 1, refunded 1
                                          lastProgressSignal: verdict-changed
```

The second round cost nothing, because the failure moved. And the stall path, with
byte-identical output both rounds: `continuations 1` then `continuations 3` — a goal
going nowhere spends its budget **faster** than before this existed, which is the
property that makes it safe on by default.

**The ceiling holds.** 17 unit tests, and the loop-safety ones are the point: a goal
with `maxContinuations: 4` and 12 refunded rounds wraps up; spent and refunded are
counted together, not separately; a scalar `maxContinuations: 1` somebody chose is
scaled from rather than overridden; and an exhausted wall-clock budget still outranks
an available refunded round.

**The negative tests are the ones that matter.** A refund is a reward, so:
editing a file does not buy one, a `claimed-only` criterion does not, an identical
verdict restated does not, and a completed task buys exactly one per goal. There is
deliberately no path from a moved worktree fingerprint to a refund, and a test
asserts that absence.

**One deviation from the brief, recorded rather than quietly made.** The brief said a
completed task should count only *alongside* a verified signal. On inspection that
makes it worth nothing — the verified signal already grants the refund by itself, so
the pairing rule would never change an outcome. It is instead one refund per goal,
ever, which does something while staying bounded. The reasoning is in
`src/lib/progress.js` next to the constant.

**What is not measured: whether it works.** Rounds-to-completion against the flat cap
is the number this brief exists to move, and it needs brief 9's harness. This ships
with a safety argument and no efficacy number, and the README says so.

## Honest limits (to be added to the README)

- **The worst case is longer than it was.** `README.md:134`'s *"two extra rounds"*
  becomes up to 3× the tier value, bounded by the wall-clock and token budgets and
  by `stop_hook_active`. The sentence in the README must be rewritten rather than
  left standing.
- **A completed task is not progress on its own.** The model writes its own task
  list, so it counts for at most one refund and only beside a verified signal. This
  makes the mechanism weaker on goals with no check and no probes — which is the
  tier that already gets the shortest leash, correctly.
- **"Stall" is two rounds with no progress signal**, not a similarity metric over
  judge reasons. This repository already established that no such threshold exists
  on real data (`README.md:711-713`), so none is attempted.
- **A goal with no verifier earns little.** `unverified` goals have no access to
  rows 1–3 except via `expect` records, so in practice the refund helps `verified`
  and `judged` goals most. That is the autonomy slider working as intended, and it
  means the headline "work on larger tasks" benefit is conditional on having a
  check command — which `README.md:658` already calls the cheapest large win here.

## Files touched

`src/lib/goals.js` · new `src/lib/progress.js` · `src/hooks/stop.js` ·
`src/lib/prompts.js` (one clause) · `README.md` (rewrite the worst-case sentence) ·
`test/goals.test.js` · new `test/progress.test.js` · `test/hooks.e2e.test.js` ·
goldens re-recorded
