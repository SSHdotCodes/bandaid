# Brief 11 — The seal: a check the worker never sees

**Discharges** `harness-report.md` §3.1. **Adds** `goals.seal`, `verify.runSeal`,
a terminal `sealPrompt`, one loop fixture, one ablation.

## The problem

Tier 1 is a command the worker can see. Its command is in the goal record and its
output comes back as the continuation's reason (`src/lib/verify.js:291`) — on
purpose, because a reason carrying only the command is constant, and a constant
reason killed converging loops and disabled brief 7's progress signal outright.

Good feedback. Also a gradient.

[SpecBench](https://arxiv.org/html/2605.21384v1) measures the consequence: the gap
between a visible suite and a held-out one grows **~27pp per 10× code size**,
reaching **100pp above 25K LOC**, and the largest share of it is *feature
isolation* — components that pass individually and do not compose. METR: reward
hacking in **30.4% of runs by default, 70–95% when the model is told not to**. That
last number is the argument against fixing this with a paragraph.

`docs/plans/00-INDEX.md:134` already recorded a symptom — "nondeterministic check
output buys unearned refunds" — without naming the cause.

## The mechanism

`--seal "<command>"`, or `goals.seal` / `BANDAID_GOAL_SEAL`. Null by default.

Two properties, both about what does not happen:

1. **It runs only on a round that is otherwise about to close the goal.** Not every
   round. A seal the worker can trigger each round is a per-round oracle, and an
   oracle is a gradient. This one speaks only at the moment of closing, so there is
   nothing to climb.
2. **Nothing it learns reaches the model.** Not the command, not the output, not a
   reason derived from either. `reason` is the constant string `held-out
   verification did not pass`; `verification.output` is `null`.

It gates both paths in `assess` that return `proven: true` — the judge's and the
check's. Fails closed, like `check`: a seal that times out or cannot spawn has
cleared nothing.

**On failure the goal blocks rather than continuing.** This is the load-bearing
decision, and the reason is not that another attempt could not fix it — it could.
It is that steering the next attempt would mean handing over the finding, and a
seal the worker is steered by is a slow `check`. An opaque constant reason fed back
into the loop would also trip the plateau breaker two rounds later, so blocking now
reaches the same place sooner and with a human in it.

Three leak paths, all closed and all tested:

- the continuation prompt — never reached, because `sealed` is terminal
- `verification` — `output: null`, so a future path that renders it by mistake renders nothing
- the ledger → judge → reason hop — `seal` records are written for the user and filtered out of the judge's rendered ledger (`verify.js` `ledgerFor`), because the judge's reason becomes the next continuation's steering one hop later

The seal does **not** earn a longer leash. It vetoes but never proves — the same
reason probes do not — and it is only reachable on a round something else was
already closing.

## Measurement

`eval/loop-fixtures/sealed` reproduces SpecBench's feature-isolation shape: a
`query()` whose `filter` and `groupBy` each pass alone and do not compose. The
visible check tests each feature in isolation and goes green on round 1.

```
npm run loop                    8/8   sealed → blocked at round 2, ended by seal
npm run loop -- --ablate seal   7/8   sealed → complete at round 1, ended by check
```

**The ablation is non-null**, which is what separates this from the evidence
ledger. Withholding the tier lets a goal close as done on an implementation that
does not do what the objective asked. The other seven fixtures are unmoved in both
runs.

`endedBy` gained a `seal` category so the three things that end as `blocked` stay
distinguishable. `--ablate seal` withholds by not configuring, alongside `ledger`,
because neither is a prompt block.

## Prompt cost

`sealPrompt` is a new golden and a new ceiling — 132 words, ceiling 137. Terminal,
like `violationPrompt`: it fires at most once per goal and never on the
continuation path, so an ordinary round costs zero.

**All ten continuation goldens are unmoved.** That is the assertion that proves the
tier did not leak into the loop, and it is worth more than the ceiling.

## Honest limit, recorded in the README

The seal is **not injected**, not **secret**. `goal.json` is on disk and the worker
has a shell. It defends against drift toward the visible signal, not against a
worker that goes looking. `sealPrompt` says as much to the model and does not
pretend otherwise.

Stating its existence is deliberate and is not the leak — a worker that knows an
unseen check will run has nothing to aim at, which is the asymmetry the tier is
for. What must not escape is its content.
