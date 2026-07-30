# 9 — The loop harness: measure the loop, not the grader

The largest brief, and the one every other brief's claims depend on.

## The failure

`eval/run.js` measures the **judge**: one verdict, over a fresh repository that
already contains the ground truth, with `turns: []` handed in deliberately so *"the
judge has to work from the repository, not from a log of what the engineer says it
did"* (`eval/run.js:156-160`). It is a good harness for what it measures, and it
produced this repository's two most useful numbers: 10/10 accuracy, and the null
result on the evidence ledger.

It cannot measure anything that lives in the continuation prompt, because the judge
never sees the continuation prompt. `eval/run.js:88-93` says so:

```js
const ABLATABLE = new Set(['criteria', 'constraints', 'blockers', 'ledger']);
// completion-audit is deliberately absent: it lives in the continuation prompt,
// which the judge never sees, so this harness cannot measure it — an honest
// limitation rather than a gap to paper over.
```

So the **277-word completion audit** — the single largest block of prose Bandaid
injects, measured at 277 of `continuationPrompt`'s 678 words
(`karpathy-report.md:107-118`) — has never been measured. Neither has the
`Progress visibility` paragraph, the `Fidelity` block, or the three separate
sentences telling the model not to shrink the objective.

And `src/lib/prompts.js:214-223` carries a promise that cannot currently be kept:

> Cut these paragraphs to their first and last sentence once `npm run eval --
> ablate completion-audit` shows precision unchanged.

That flag does not exist. The promise is dated and unkeepable.

## What this brief also settles, for free

`karpathy-report.md:345-351` names the fixture the evidence ledger needs to be kept
or killed, and says it does not exist:

> the fix is a fixture the harness cannot express yet: **two sequential judgements
> over a repository that changes between them.** Until that exists, the ledger is
> an unmeasured bet.

That is *the same thing* as a loop harness. A harness that runs round *n*, mutates
the repository, and runs round *n+1* is by construction two sequential judgements
over a changing repository. One build settles three open items: the completion
audit's measurability, the ledger's value, and the single-shot ceiling
(`karpathy-report.md:345-351` — every existing fixture is single-shot over a fresh
repo, and both ablation runs sit at 100% so the suite has no headroom).

## What it is

`eval/loop.js` — a harness that runs Bandaid's Stop loop, not its judge.

```
node eval/loop.js                          # all loop fixtures
node eval/loop.js --filter converging
node eval/loop.js --rounds 8               # ceiling on rounds per fixture
node eval/loop.js --ablate completion-audit
node eval/loop.js --ablate capacity
node eval/loop.js --ablate elapsed
node eval/loop.js --ablate ledger
node eval/loop.js --arm autonomy,leash     # feature flags under test
node eval/loop.js --json
```

### The loop, one round

1. Seed a throwaway repo and a throwaway `BANDAID_HOME` (the pattern
   `eval/run.js:115-150` already uses: mkdtemp both, restore and delete in
   `finally`).
2. Seed a goal with objective, criteria, constraints, blockers, base SHA.
3. Run `src/hooks/stop.js` as a subprocess with JSON on stdin — the way
   `test/hooks.e2e.test.js:24-39` does it, and the way Claude Code does it. Not
   in-process: the exit code *is* the meaning, and a subprocess is the only honest
   test of that.
4. Capture exit code and stderr. Exit 0 = the loop released. Exit 2 = stderr is the
   continuation prompt.
5. **Apply the round's mutation to the repository.** This is the new part and the
   whole point.
6. Repeat until the loop releases or `--rounds` is hit.

### The mutation problem, and how to solve it without a model

Step 5 is where a naive design would put an LLM: hand the continuation prompt to a
model, let it work, see what happens. That is the real thing and it is the wrong
harness — non-deterministic, slow, expensive, and it measures the model rather than
the mechanism.

Instead, each fixture ships a **scripted worker**: a sequence of mutations, one per
round, that stands in for what a model would do.

```
eval/loop-fixtures/converging/
  objective.txt
  criteria.txt
  repo/                  the starting state
  check.sh               optional
  rounds/
    01.sh                applies round 1's work to the repo
    02.sh
    03.sh                after this, check.sh exits 0
  expected               { releases: true, byRound: 3, reason: "check passed" }
```

A scripted worker is deterministic, free, and reviewable. It cannot tell you
whether the *prose* persuaded a model — no harness can, without a model — but it
can tell you everything else: how many rounds the loop takes to release on work
that is genuinely converging, whether it releases early on work that is not,
whether a blocker ends it, whether a refund extends it, whether the plateau
detector ever fires.

**And it can measure the prompt blocks after all, indirectly and honestly.** With
`--ablate completion-audit`, the prose is withheld and the *scripted* worker is
unchanged, so any change in the outcome is attributable to the mechanism rather
than to the prose. That measures whether the audit affects the *loop's* decisions —
which is a real question with a real answer, and it is a strictly weaker claim than
"the audit makes models more honest". The brief must say which claim it is making.
See "What this cannot measure" below.

### The fixtures

Six, each isolating one behaviour the flat-cap harness cannot reach:

| Fixture | Shape | Expected |
|---|---|---|
| `converging` | Each round completes one of three criteria; check passes at round 3 | Releases at 3, `reason: check passed` |
| `stalling` | Every round edits a file; no criterion ever completes; check output byte-identical | Gives up. **Which mechanism ends it, and in how many rounds, is the number brief 8 needs** |
| `stalling-varied` | Same, but the check output differs each round | The case the plateau breaker cannot catch and brief 7's stall rule can |
| `false-done` | Round 1 makes the repo *look* finished — stub with a vacuous test, à la `eval/fixtures/stubbed-test` — and stops | Must **not** release. This is the false-close guard |
| `blocked` | Round 1 records a real blocker; rounds 2–3 progress everything else | Releases, with the blocked criterion not counted toward completion |
| `ledger-moving` | Two rounds of *genuine* progress with a revert between them — the fixture `karpathy-report.md:345-351` asks for | Round 2's judgement must not be fooled by round 1's now-stale evidence |

`ledger-moving` is the one that settles the evidence ledger. Run it with and
without `--ablate ledger`: if the ledger's presence changes the round-2 verdict,
the ledger earns its 3000 tokens. If it does not, it goes, and the null result from
`README.md:853-861` becomes final rather than provisional.

### What it reports

```
$ node eval/loop.js
  fixtures        6
  releases        5/6 correct   (false-done correctly held)
  rounds          converging 3 (expected 3) · stalling 2 · stalling-varied 4
  false-close     0
  false-block     0
  ended by        check 2 · stall 2 · blocker 1 · budget 1 · plateau 0
  verdict         pass
```

`ended by` is the diagnostic that matters most across briefs 7 and 8: a mechanism
that ends zero loops across every fixture is a mechanism to delete, and this row is
where that becomes visible. `plateau 0` in the sample above is the expected — and
predicted — outcome.

## What this cannot measure, stated plainly

The scripted worker is not a model, so:

- **It cannot tell you whether a paragraph of prose changes a model's behaviour.**
  `--ablate completion-audit` measures whether the *loop* behaves differently
  without it, given a fixed worker. A prose block that only affects what the model
  chooses to do is invisible here. The honest claim is therefore narrow, and the
  README must state it in exactly those terms rather than letting "we ablated the
  completion audit" imply more.
- **It cannot produce a general claim about the judge.** That is `eval/run.js`'s
  job, and its ten fixtures on one theme with Haiku are already labelled *"a floor,
  not a general claim"* (`README.md:887`).
- **An optional model-in-the-loop mode** (`--worker claude`) is worth building
  *after* the scripted version, as a second, expensive, non-deterministic tier —
  the way `judge: false` is off by default because it costs a subprocess and 12–16
  seconds (`README.md:726-729`). It is out of scope for this brief and named as the
  obvious successor.

Saying this up front is the difference between a harness that measures something
and a harness that launders an assumption. `eval/run.js` set that precedent by
excluding the completion audit rather than pretending to cover it; this brief
inherits the standard.

## Integration and cost

Not in `npm test`. `npm test` stays dependency-free, network-free, and about 22
seconds; a harness that copies repositories and runs shell scripts belongs beside
`npm run eval`. Add `npm run loop`.

Runtime target: under 60 seconds for all six fixtures with scripted workers, so it
is cheap enough to run on every prompt change — which is the point. A harness
nobody runs measures nothing.

## Tests (of the harness itself)

The harness is code and gets tested, because a broken harness produces confident
wrong numbers — the exact failure `eval/run.js:11-27` was written to prevent
(*"a judge that returns 'complete' on a stubbed test … launders a model's
self-assessment as an independent one"*).

| Test | Asserts |
|---|---|
| new `test/loop-harness.test.js` | A one-round fixture with a passing check releases at round 1; the temp repo and temp `BANDAID_HOME` are both deleted even when a round script fails |
| | `--rounds` is honoured and reported as a truncation rather than as a release |
| | A round script that exits non-zero fails the fixture loudly rather than being read as "no change" |
| | Ablation flags actually withhold their block: the captured stderr does not contain the withheld text |

That last row is the one that keeps every ablation number honest.

## Measurement

The harness's own measurement is its fixture expectations: six fixtures with
declared outcomes, exit non-zero on any mismatch. Beyond that, its value is that
briefs 5, 7, 8 and 10 become decidable. Those numbers belong to those briefs.

One number belongs here: **the rows of `ended by` that are zero across all six
fixtures.** Publish it. It is the list of mechanisms this repository is carrying
that nothing reaches.

## Measured, as built

```
$ npm run loop
  fixtures   7
  correct    7/7

  ok   blocked            released after 2 round(s) · ended by blocker
  ok   converging         released after 3 round(s) · ended by check
  ok   false-done         released after 4 round(s) · ended by plateau
  ok   ledger-moving      released after 5 round(s) · ended by plateau
  ok   slow-converging    released after 4 round(s) · ended by check · 2 refunded
  ok   stalling           released after 4 round(s) · ended by plateau
  ok   stalling-varied    held after 6 round(s) · ended by rounds-exhausted · 5 refunded

  ended by   check 2 · complete 0 · stall 0 · plateau 3 · blocker 1 · violation 0 · budget 0 · rounds-exhausted 1
  DEAD       stall  — a fixture aims at it and it never fires
  uncovered  complete, violation, budget  — no fixture reaches these; says nothing about them
```

### It found a real bug on its first run, and the bug was one line

`src/lib/verify.js` set the failure reason to **the command, not the output**:

```js
reason: `check failed: ${command}`,     // constant for a given goal
```

That string is what `plateauReached` compares for byte-equality and what
`progress.detect` compares for change. With only the command in it, two mechanisms
were broken at once and in opposite directions:

- **The plateau breaker fired after *any* two consecutive failing check rounds**,
  regardless of whether anything had improved. Not "almost never fires" as
  `README.md` had it, and it never looked at the output it was documented to compare.
- **Brief 7's `verdict-changed` progress signal could never fire at all** for a
  check-based goal, because the reason it watches for change was constant.

**The consequence, demonstrated.** The `slow-converging` fixture lands one of four
pipeline stages per round, and its check reports `only 1 of 4 stages done`, `only 2
of 4`, `only 3 of 4` — visible progress, different output every round. It was
**terminated at round 3, before it could go green at round 4**:

```
before the fix:  FAIL slow-converging  ended by plateau   (expected complete, got budget_limited)
after the fix:   ok   slow-converging  ended by check · 2 refunded   (releases at round 4)
```

So any check-command goal needing more than two rounds to go green was being killed
early — the exact opposite of "work on larger tasks without stopping", and it was
invisible to every test in the repository because no test ran the loop.

### The `DEAD stall` row, and why brief 8's prediction was backwards

Brief 8 predicted the plateau breaker was redundant because brief 7's stall rule
"fires earlier and on more cases". The measurement says the reverse: **the plateau
breaker ends three of the four stuck fixtures and the stall rule ends none.**

The cause is ordering, not deadness. `plateauReached` is checked at
`src/hooks/stop.js:242`; `progress.settle`, which computes the stall, runs at `:262`.
On any stuck loop plateau reaches its limit first and the stall never gets to be the
thing that ends it. The stall's double-cost is still computed and still accelerates
the budget — it simply never wins the race.

Whether the stall rule reaches anything plateau cannot is **unverified**: it would
need a judge-based fixture whose prose varies while nothing improves, and the judge
needs `claude` on `PATH`. That fixture does not exist.

### A weakness it surfaced in brief 7

`stalling-varied` earns **5 refunds across 6 rounds of pure churn**. Its check output
varies every round without the work advancing, so `verdict-changed` reads noise as
progress. A real test suite that prints timings or randomises order would do the
same. It is bounded — the 3× round ceiling and the wall-clock budget both hold — but
"the output changed" is a weaker proxy for progress than it looks, and this is the
number that says so.

### What the row does not say

`complete`, `violation` and `budget` fired zero times because **no fixture reaches
them**, which is a gap in this suite and says nothing about those mechanisms. The
output separates that case from `DEAD` on purpose: conflating a coverage hole with a
dead mechanism would hand brief 10 three false deletion candidates.

## Honest limits (to be added to the README)

- **The worker is a script, not a model.** The harness measures the loop's
  mechanics — when it blocks, when it releases, what ends it — not whether prose
  persuades. Every ablation number from it carries that scope, and none of them
  should be quoted as though it measured the model.
- **Six fixtures on one theme.** Same caveat `eval/run.js` already carries: a
  regression detector, not a general claim.
- **`--worker claude` does not exist.** The model-in-the-loop tier is named,
  deliberately unbuilt, and is what would be needed to measure prose properly.
- **It runs shell scripts from fixture directories.** They are committed, reviewed,
  and run in a throwaway copy — but they are not sandboxed, the same limit
  `README.md:749-752` already states for sweep reproductions.

## Files touched

new `eval/loop.js` · new `eval/loop-fixtures/` (six fixtures, each with a repo and
round scripts) · `package.json` (`npm run loop`) · `src/lib/prompts.js` (ablation
seams for each block) · `README.md` · new `test/loop-harness.test.js`
