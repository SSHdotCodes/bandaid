# 4 — The ETA estimator, and the backtest that scores it

## The failure

The objective asks for an "ETA for task counts". Bandaid currently reports two
numbers about capacity (`src/lib/prompts.js:258-262`):

```
Budget:
- Continuation: 2 of 4
- Tokens used: 41823
- Token budget: none
- Tokens remaining: unbounded
```

Nothing about time, and nothing about how much work is left. Briefs 2 and 3 make
both computable from things that were measured rather than guessed. This brief
turns them into one figure, and — more importantly — builds the thing that says
whether the figure is any good.

## The rule this brief is written under

**An ETA without an error bar is a guess wearing a number.** That is worse than no
ETA, because a bare figure gets acted on. So the deliverable is not an estimator;
it is an estimator *plus a backtest*, and the estimator only ships if the backtest
says it beats the dumbest thing that could work.

The baseline it has to beat:

```
remaining_ms = median(observed task durations) × tasks_remaining
```

That is one line of code, needs no per-tool profile, and is a genuinely decent
estimator. If the sophisticated version does not beat it, **the baseline is the
deliverable** and the README says so. This repo has already published one null
result about one of its own mechanisms (`README.md:853-861`) and treats that as a
result rather than a defeat; the same standard applies here.

## The estimator

Inputs, in order of preference — the estimator uses the best available and records
which:

1. **Task-based** (needs brief 3): `tasks_remaining` × a duration drawn from this
   session's own completed tasks, falling back to the project's history when the
   session has fewer than 3 completions. Uses a trimmed median, not a mean: one
   task that took two hours should not double the estimate for four that took ten
   minutes.
2. **Continuation-based** (needs brief 1 only): mean interval from
   `goal.continuationAt[]` × an assumed number of remaining rounds derived from
   the criteria-coverage figure `evidence.summarize` already computes
   (`src/lib/evidence.js:172`). Coarser, but available on any goal, including one
   where the model never used `TodoWrite` — which brief 3's measurement will tell
   us is a common case or not.
3. **Nothing** — fewer than 3 observations of any kind. **Renders no ETA.** Not
   "unknown", not a wide range: the line is absent. This is the same discipline as
   brief 1's render rules and `evidenceSummaryFor` (`src/hooks/stop.js:46-56`).

### The error bar

Reported as an interval from the observed spread, not from a formula:

```
ETA: ~35m remaining (4 of 10 tasks done; range 20m–1h10m)
```

The range is the p25–p75 of observed durations scaled by tasks remaining. It is
deliberately an interquartile range rather than a confidence interval, because a
confidence interval implies a distributional assumption this data does not earn —
tool and task durations are long-tailed and n is routinely under 20.

Where a `gap`-derived duration (brief 2) is in play, the estimate inherits that
derivation's inflation, and the render says which derivation it used when they
disagree materially. Brief 2 requires consumers to segment by `timing` rather than
average across it; this is where that requirement is honoured.

## The backtest — `eval/eta-backtest.js`

Modelled on `eval/run.js`'s posture, which is the right one: it measures a
mechanism, exits non-zero when the mechanism fails, and **skips cleanly when its
inputs are absent** (`eval/run.js:185-189` probes for `claude` and skips). It is a
measurement tool, not a test, and it is not in `test/*.test.js` — `npm test` must
stay dependency-free, network-free and fast.

```
node eval/eta-backtest.js                    # all recorded sessions
node eval/eta-backtest.js --filter bandaid   # one project
node eval/eta-backtest.js --json
node eval/eta-backtest.js --ablate fuzzy     # exclude fuzzy-matched task durations
node eval/eta-backtest.js --ablate profile   # task-based only, no per-tool profile
```

### How it works

Replay, not simulation. For each recorded session that reached a terminal goal
status, walk its `tasks.jsonl` and `turns.jsonl` forward. At every point where the
estimator *would* have rendered an ETA, compute it from only the data available at
that point, and compare against the wall-clock that actually elapsed from there to
the goal's close.

The prefix discipline is the whole correctness argument: an estimator that can see
the future scores perfectly and means nothing. So the replay hands the estimator a
truncated ledger, and a test asserts that it does — `test/eta.test.js` verifies the
estimator returns different answers at turn 3 and turn 9 of the same session and
never reads past its cutoff.

### What it reports

```
$ node eval/eta-backtest.js
  sessions   14 (312 estimate points)
  MAPE       est 34%   baseline 51%
  within 2x  est 78%   baseline 61%
  bias       est +12%  baseline +38%     (positive = overestimates remaining)
  by timing  hook n=0   gap n=312
  verdict    beats baseline on MAPE and within-2x
```

Four figures, each chosen because it fails differently:

- **MAPE** — the headline. Mean absolute percentage error.
- **within 2×** — the figure that matters for a *decision*. Nobody acts on the
  difference between 30 and 35 minutes; everyone acts on the difference between 30
  minutes and 4 hours. An estimator can lose on MAPE and still win here, and if it
  does, that is the one to prefer.
- **bias** — signed. A systematically optimistic ETA is worse than a
  systematically pessimistic one, because the failure mode is a model that decides
  it has time it does not have.
- **by timing** — accuracy split by brief 2's derivation, so inherited noise is
  attributed rather than absorbed.

Exit non-zero when the estimator loses to the baseline, so the decision is
mechanical rather than rhetorical.

### The fixture problem, stated honestly

The backtest needs recorded sessions, and on day one there are none. Three
sources, in order:

1. **This repository's own sessions.** Executing briefs 1–3 and 5–10 generates
   exactly the multi-hour multi-task sessions this needs. That is a real and
   sufficient corpus, and it arrives as a side effect of the work.
2. **Synthetic sessions** committed under `eval/eta-fixtures/` for the properties
   real data will not reliably contain: a session that restructured its plan
   halfway, one that stalled for an hour then finished fast, one with three tasks
   and one with sixty. These pin behaviour; they do not establish accuracy.
3. Until (1) has accumulated, **the estimator does not ship enabled**. It is
   written, tested, and reported as unmeasured — the same label
   `karpathy-report.md:875-879` applies to the evidence ledger, and for the same
   reason.

That ordering is the point. An ETA shipped on synthetic data would be a number
nobody had checked against reality, injected into a prompt, in a repository whose
whole argument is that unverified mechanisms are the problem.

## The render

One line, folded into brief 5's capacity line rather than added beside it:

```
Capacity: continuation 2/4 · 3h18m of 6h · ~35m remaining (4/10 tasks, range 20m–1h10m)
```

Rendered only when the estimator has ≥3 observations and the backtest has
certified it. Absent otherwise. The line is ablatable behind a flag from day one
so brief 10 can withhold it — brief 9's harness cannot measure a block that is not
switchable.

## Tests (`npm test`, not the backtest)

| Test | Asserts |
|---|---|
| new `test/eta.test.js` | Trimmed median on known samples; fewer than 3 observations → `null`, never a number; the p25–p75 range brackets the point estimate; the estimator never reads past its cutoff index |
| | Preference order: with tasks present uses task-based; with tasks absent falls back to `continuationAt[]`; with neither returns `null` |
| | A single 2-hour outlier among four 10-minute tasks moves the estimate by less than 25% (this is the trimmed-median property, stated as a behaviour) |
| `test/prompts.snapshot.test.js` | New golden with the ETA present and the existing goldens unchanged with it absent |
| new: baseline | The baseline estimator itself is tested, because the comparison is meaningless if the thing being beaten is broken |

## Measurement

The backtest **is** the measurement, and its numbers go into the README next to
the eval matrix, in the same format and with the same candour — including the
sample size, which will be small at first and should be stated rather than
smoothed over.

Three outcomes and all three are acceptable:

- **Beats the baseline** → ships enabled, numbers published.
- **Loses to the baseline** → the baseline ships, the sophisticated estimator is
  deleted, and the README records that median × remaining was as good as anything
  built on a per-tool profile. Brief 2's profile then has no consumer and goes
  with it.
- **Neither beats the other on a corpus this small** → ships disabled, labelled
  unmeasured, with the sample size that would settle it named.

## Measured, as built

The backtest was run before the estimator was wired to anything, and it changed
the estimator twice.

**It caught its own methodology first.** The first version scored a MAPE of
**837,734%**. The arithmetic was correct and the number was meaningless: the
ground-truth horizon was "the last task event in the session", and the only
session with task data is *still running*, so `actual` approached zero near the end
and the percentage exploded. Two fixes, both now in the harness:

- A session whose task list is still open **has no horizon and is skipped**. Its
  last event is where the work had got to, not where it ended.
- Points where the actual remaining is under a minute are dropped. A percentage
  error against a three-second actual is not a measurement.

A harness that emits 837,734% is producing exactly the confident wrong numbers a
harness exists to prevent, so this counts as the harness working.

**Then it deleted the estimator's one distinguishing feature.** On
`eval/eta-fixtures/finished-eight.jsonl`, scored on the 10 points where both
answer:

```
  MAPE       est 24%   baseline 22%
  within 2x  est 100%   baseline 100%
  bias       est -22%   baseline -21%
```

The trimmed median measured *worse* than the plain median. Two points on ten
paired points from one synthetic fixture is not a real difference — and "not a
real difference" is not a reason to keep the more complicated one, so **the
trimming is gone** and the point estimate is now the baseline's arithmetic.

**Which makes the verdict "indistinguishable", and that is the honest reading.**
Once trimming went, the two differ only in how each breaks an even-count tie
(average-of-the-two-middles against upper-middle), which is the whole remaining
2-point gap. Reporting that as a loss would be as misleading as reporting it as a
win, so the harness has a third verdict and a tolerance set from the observed
cause rather than picked.

**What ships unmeasured, and is labelled so:** the observation floor (the
estimator declines below 3 samples where the baseline answers from 1 — it declined
4 of 14 points), the interquartile range, and the continuation basis. The backtest
scores none of the three. They are argued for, not measured, and the argument is
in the code.

**Real-session coverage: zero.** 15 transcripts examined, 1 had a task list, and
that one is unfinished. So every number above comes from a fixture the author
wrote, which establishes that the harness scores and nothing about accuracy on
real work. `npm run eta` is the thing that will say otherwise once sessions
accumulate.

## Honest limits (to be added to the README)

- **The estimate is only as good as the task list.** A model that writes three
  coarse tasks for a day's work gets an ETA built on three samples. Brief 3's
  fixtures cover the mechanics; nothing can cover a bad decomposition.
- **`gap`-derived durations include model thinking time** (brief 2), so on this
  data the ETA measures wall-clock-to-completion rather than work-to-completion.
  Those differ most on exactly the long deliberative turns where an ETA is most
  wanted.
- **It cannot see work it has not been told about.** A criterion needing a
  code-review round trip, a deploy, or a human decision is not a task in the list
  and contributes nothing to the estimate. Blockers are recorded separately
  (`bandaid goal block`) and are excluded rather than estimated.
- **The corpus is this repository's own sessions.** A codebase with a 20-minute
  test suite will find the calibration wrong in the same direction every time.
  Per-project profiles (brief 2) mitigate it; they do not fix it.

## Files touched

new `src/lib/eta.js` · `src/lib/prompts.js` · `src/hooks/stop.js` ·
new `eval/eta-backtest.js` · new `eval/eta-fixtures/` · `bin/bandaid.js`
(`goal status` shows the ETA) · `README.md` · new `test/eta.test.js` ·
`test/prompts.snapshot.test.js`
