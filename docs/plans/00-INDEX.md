# Plans: a clock, an ETA, and a longer leash

Ten briefs, plus two that came later from a different input. Each is roughly 100k
tokens of implementation work, individually scoped, individually measured, and
individually deletable.

Briefs 11 and 12 are appended at the bottom. They do not belong to the objective
below — they come from `harness-report.md`, which read users rather than
implementations, and they are here because they are written under the same rules.

The objective they serve: Bandaid can keep a turn from ending, but it cannot tell
the model what time it is, cannot say how long the remaining work will take, and
treats any sentence ending in `?` as grounds to stop. Three gaps, two of which
this repository already wrote down as unfinished.

## The rule these briefs are written under

`karpathy-report.md:242` — *"do not add prompt prose without an eval."*
`test/prompts.snapshot.test.js` header — the word-count ceilings *"are not
targets. Every one of them should be going down."*
`README.md:849-851` — *"a mechanism whose ablation moves no number is a mechanism
to delete, and saying so in advance is what makes deleting it a result rather
than a defeat."*

Nine of these ten briefs add a mechanism or add prose. Brief 10 is the bill, and
brief 9 is the harness that makes the bill computable. A brief with no
measurement section is not ready to execute.

## The ten

| # | Brief | Adds | Decided by |
|---|---|---|---|
| 1 | [The clock, and a wall-clock budget](01-clock.md) | `Elapsed:` block; `goals.timeBudgetMs` | New golden + ceiling; `decideOnStop` branch; e2e stderr assertion |
| 2 | [Per-batch duration](02-durations.md) | `startedAt`/`durationMs`; per-tool profile | Unit tests on both derivations. No prompt change — earns its place by being read |
| 3 | [The task ledger](03-task-ledger.md) | `tasks.jsonl`; counts and per-task durations | Fixture corpus incl. a mid-task restructure, against hand-computed truth |
| 4 | [The ETA estimator](04-estimator.md) | An ETA with an error bar | `eval/eta-backtest.js` — ships only if it beats median × remaining |
| 5 | [One capacity line](05-capacity-line.md) | Replaces the 5-line `Budget:` block | Must *lower* `continuation-bare`'s ceiling; ablated in brief 10 |
| 6 | [Autonomy](06-autonomy.md) | `goals.autonomy`; a trailing-question classifier | Precision on the *allow* class, on a fixture corpus |
| 7 | [An earned leash](07-earned-leash.md) | Progress-conditioned continuations | Brief 9's harness: rounds-to-completion vs the flat cap |
| 8 | [Two counters](08-counters.md) | Wires `blockedStreak`; settles the plateau breaker | Brief 9's harness on a non-converging fixture |
| 9 | [The loop harness](09-loop-harness.md) | Measures the loop, not the grader | Itself |
| 10 | [Pay the bill](10-token-reclaim.md) | Deletes what earns nothing | The full ablation matrix |

## Dependency graph

```
1 clock ──┬─→ 5 capacity line ──┐
2 duration┤                     ├─→ 10 reclaim
3 tasks ──┴─→ 4 estimator ──────┤
                                │
6 autonomy ─┐                   │
7 leash ────┼─→ 9 loop harness ─┘
8 counters ─┘        ↑
        (6, 7, 8 are authored before 9, verified after it)
```

Briefs 1–4 go first: additive, independent of 6–8, and brief 4's backtest wants
briefs 2 and 3's data to have accumulated for a while. Brief 9 is scheduled after
6–8 exist but before their numbers are claimed — building the harness first would
mean building it against imagined mechanisms.

## Standing constraints for every brief

1. **`npm test` exits 0 before the brief is called done.** 324 tests at the time
   of writing, `node --test`, no dependencies, no network. Checked per brief, not
   once at the end.
2. **`npm run eval` stays at 10/10.** No prompt edit may cost judge accuracy.
   `constraint-violated` is known-flaky at 6 of 8 (`README.md:890`); one miss
   there is not a regression.
3. **Goldens change only deliberately.** `UPDATE_SNAPSHOTS=1 npm test`, then the
   diff is read and quoted in the commit message. A raised ceiling is its own
   reviewed line in a diff.
4. **Nothing uses elapsed time to decide whether evidence is still valid.**
   `src/lib/stamp.js:12-15` rejects TTLs for that purpose and is right; validity
   stays content-hashed. Time is a budget here, never a cache rule.
5. **Every new prompt block is ablatable by brief 10.** If it cannot be withheld
   behind a flag, it cannot be measured, and it does not ship.

## Status

| # | State |
|---|---|
| 1 | **shipped.** 364 tests (was 324), `npm run eval` 10/10 unchanged, two new goldens and no existing golden moved, `doctor` clean. The elapsed block costs 15 words on the continuation prompt; brief 5 is where that comes back |
| 2 | **shipped, and the brief was wrong in a useful way.** The transcript carries real per-call durations — 196 of 196 calls matched, zero negatives, idempotent across three syncs — so `gap` dropped from the main path to an unused fallback. 390 tests. No model-facing surface, as scoped |
| 3 | **shipped, and the identity problem turned out not to exist on the main path.** `TodoWrite` appears in zero local transcripts; `TaskCreate`/`TaskUpdate` carry stable ids, so durations are exact. Validated against this session's real calls: 11 tasks, 3 complete, 12m/23m/10m, all correct. 410 tests. The corpus caught two bugs that would have shipped confident wrong numbers |
| 4 | **shipped, and the backtest changed it twice.** It caught its own methodology first (a MAPE of 837,734% from scoring an unfinished session), then deleted the trimmed median for measuring worse than a plain one. Verdict on the one scoreable fixture: indistinguishable from the baseline. Zero real-session coverage, labelled unmeasured |
| 5 | **shipped, and it paid for briefs 1 and 4.** One capacity line replaced the four-line `Budget:` block: **−15 words on each of ten continuation goldens, −150 total**, while adding a wall-clock budget and an ETA. Every ceiling came down. 434 tests |
| 6 | **shipped, off by default, and on in this machine's config.** Gate holds: 10/10 genuine questions still allowed, 15/16 permission-asks caught. The scoring metric was wrong first — it counted a harmless miss as a precision failure — and the paragraph came in at 79 words against a ≤70 budget and was cut to 57. 463 tests |
| 7 | **shipped, bounded, and unmeasured.** A round that moves the work is refunded, a round that moves nothing twice costs double, ceiling at 3× the tier. Asserted end to end both ways; the negative tests (an edit buys nothing, a `claimed-only` criterion buys nothing, a moved fingerprint buys nothing) are the important ones. Whether it reduces rounds-to-completion needs brief 9. 483 tests |
| 8 | **settled, and both halves came out backwards.** Part A's premise was stale — `blockedStreak` is wired and `blockedThreshold` never existed — so no counter was added and two tests pin the wiring instead. Part B: the plateau breaker was not dead, it was firing too eagerly on a bug, and it ends 3 of 4 stuck loops. The stall rule is the one that never fires |
| 9 | **shipped, and it earned its place immediately.** 7 fixtures, offline, ~17s. Found a one-line bug that was killing converging loops and had disabled brief 7's progress signal outright. Reports `DEAD stall`, and separates that from `uncovered` so a coverage hole cannot read as a deletion candidate |
| 10 | **run, and it deleted nothing — for a stated reason.** Every prompt-block ablation is byte-identical, because a scripted worker does not read prompts; that is the only possible outcome, not a finding. The 277-word audit is kept and its sunset note rewritten. The ledger's "the suite cannot express this" defence is spent and its answer unchanged. Four of eight predictions were wrong |

### A defect found by using the tool on itself

Recording the five criteria as evidence and attaching six runtime-verified
expectations left `bandaid self-check` still reading **`0 of 5 criteria have
measured, current evidence`**. That is not a reporting bug, it is a real gap:

- `selfcheck.addExpectation` takes no `--criterion`, so an expectation is never
  attached to one.
- `verify.assess` writes an `expect` record **only when an expectation fails**
  (`src/lib/verify.js:293`, `verdict: 'refuted'`). A passing one records nothing.

So `expect` is in `MEASURED_KINDS` (`src/lib/evidence.js:43`) but is unreachable on
the passing path, and `self-check` can only ever show `covered` via a check, a
probe, or the judge. The expectations are real — they block a stop the moment one
stops holding — but they cannot say so in the coverage arithmetic.

Not fixed here: closing it means adding `--criterion` to `goal expect` *and*
recording passing expectations, which is a decision about ledger volume rather than
a typo. It belongs to whichever brief takes on `self-check`.

### What the ten briefs cost and bought

All ten executed. **491 tests** (from 324), `npm run eval` unchanged at 10/10,
`npm run loop` 7/7, `npm run autonomy` gate held, `doctor` clean.

Net effect on the prompt: **−15 words on an ordinary continuation**, having added a
wall-clock budget, an ETA, and an earned leash. Every ceiling came down or is new.

Three bugs found by measurement rather than by reading:

1. **The failure reason carried the command, not the output** — so the plateau
   breaker killed converging loops and brief 7's progress signal could never fire.
   Found by brief 9 on its first run; invisible to 483 tests because none ran the loop.
2. **`bandaid <anything> | head` died with an unhandled `EPIPE`.** Found by using it.
3. **An expectation can never make a criterion `covered`** despite `expect` being a
   measured kind. Found by pointing Bandaid at its own goal.

### Still open, and named rather than left implied

- **Prose is unmeasured.** The loop worker is a script, so no ablation can justify
  cutting a paragraph. `--worker claude` is the tier that would; it is not built.
- **The stall rule is shadowed by the plateau breaker** and may reach nothing the
  plateau breaker cannot. Settling it needs a judge-graded fixture whose prose varies.
- **The ETA has zero real-session coverage.** `npm run eta` reports nothing scoreable
  until sessions with finished task lists accumulate.
- **Nondeterministic check output buys unearned refunds**, bounded only by the ceiling.
- **No loop fixture ends a round with a permission-ask**, so brief 6's paragraph is
  untested by ablation.

**Brief 3's finding reshapes brief 4.** A task list exists for **1 of 15** local
sessions. Task-count ETA is therefore the exception, not the rule, and brief 4's
`continuationAt[]` path is the main one.

---

## Two more, from reading users instead of implementations

`best-goal-report.md` read Codex and Claude Code from source and docs.
`karpathy-report.md` read a method. `harness-report.md` read bug trackers, field
guides, and the 2026 measurement literature across four harnesses — and found that
most of what people complain about was already answered here. Two things were not,
and both landed on the tiers this repository trusts most rather than the ones it
hedges.

Two findings from that survey did not become briefs, and are recorded because they
change how the existing work should be read:

- **Codex [#19910](https://github.com/openai/codex/issues/19910) is a user asking
  OpenAI for something this plugin already does.** Codex re-injects the objective
  after compaction but not the completion audit, so the agent wakes up knowing the
  goal and not the bar, and closes it. `src/lib/restore.js:205-222` carries the
  objective *and* the fixed criteria across the reset, and the audit is regenerated
  from `goal.json` every continuation rather than living in history at all. This is
  the clearest external evidence that the compaction half and the goals half belong
  in one plugin.
- **Pi has no goal system on purpose**, and its author reports not missing
  compaction either. That is the control case for everything here: these mechanisms
  are a bet that nobody is watching the turn. Worth keeping visible, because it is
  the assumption every brief inherits without restating.

| # | Brief | Adds | Decided by |
|---|---|---|---|
| 11 | [The seal](11-seal.md) | `goals.seal`; a held-out check the worker never sees | `npm run loop -- --ablate seal` — the fixture closes `complete` without it |
| 12 | [Criteria independence](12-criteria-independence.md) | `runCriteria`; an acceptance gate | `npm run criteria` — coverage of hand-written ground truth |

| # | State |
|---|---|
| 11 | **shipped, and its ablation is not null.** A new loop fixture in SpecBench's feature-isolation shape closes as `complete` at round 1 with the seal withheld, and blocks at round 2 with it. 8/8 → 7/8 ablated, other fixtures unmoved. Three leak paths closed and tested, including the ledger→judge→reason hop nobody would have found by reading. Costs one terminal golden and zero words on any continuation |
| 12 | **shipped, and the number it produced is half-trustworthy on purpose.** Independent derivation covers 89% of ground truth against a worker baseline's 33%, stable over 9 samples — but the baseline is three lists the fixture author wrote knowing the score. The independent arm is measured; the *margin* is not, and the brief says so rather than quoting 56 points |

### What these two did not change

**Every one of the ten continuation goldens is unmoved.** Both mechanisms default to
off and are byte-identical for a user who turns neither on — the property brief 10
established and the one most worth not spending. The seal's prompt is terminal and
the criteria prompt is a subprocess, so neither is paid on an ordinary round.

### Still open, added by these two

- **An unsatisfiable goal is bounded but never diagnosed.** Claude Code #58348's ask
  — notice that a condition references something that does not exist and say so once
  — is not built. The round ceiling caps the damage and the plateau breaker catches
  the repeating case, but a model that rephrases its complaint each round defeats the
  comparison, and neither mechanism explains what happened.
- **The worker baseline in `npm run criteria` is authored, not observed.** The
  fixture that would settle brief 12's margin needs criteria captured from real
  mid-conversation goal-setting. Same shape as brief 9's scripted worker.
- **The seal is not shown, not unknowable.** `goal.json` is on disk and the worker
  has a shell. It answers drift, not curiosity.

### Brief 1, as built vs as written

Two departures worth recording, both discovered by a test:

- **The `SessionStart` clock is not its own emit.** The brief said SessionStart
  would carry the clock; three end-to-end tests then failed, because they assert a
  startup session with nothing to offer injects *nothing*. They were right — that
  is the zero-steady-state property — so the clock rides along as a prefix on
  blocks that were already being paid for, and a session with nothing to say still
  says nothing.
- **`timeUsedMs` lives in `duration.js`, not `goals.js`.** `prompts.js` needs it,
  and `restore.js` already requires `prompts.js`, so a `prompts → goals` edge would
  have closed a require cycle. The leaf module owns it and both callers import it.
