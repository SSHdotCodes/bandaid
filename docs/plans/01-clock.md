# 1 — The clock, and a wall-clock budget

## The failure

The model has no clock. Nothing Bandaid injects says what time it is, how long
this session has run, or how long this goal has been open. A model that cannot
see the time cannot tell a ten-minute task from a four-hour one, and cannot know
that it has been circling the same file since lunch.

The data is very nearly all there and none of it is read:

- `goal.json` carries `createdAt` and `updatedAt` (`src/lib/goals.js:229-230`,
  `:410`).
- Every prompt record carries `ts` (`src/lib/store.js:166`); every turn batch
  carries `ts` (`src/lib/store.js:188`).
- `meta.json` carries **no** `startedAt`, so session age is today only derivable
  from `prompts.jsonl[0].ts`. This is the one field that has to be added.

And every recorded timestamp is written but almost never read. The consumers are:
a chronological merge sort (`src/lib/ledger.js:46`), a pointer sort
(`src/lib/store.js:430`), the session-ambiguity window (`:439-440`), `ageInDays`
(`src/lib/project.js:145`), the retention sweep interval
(`src/hooks/session-start.js:37-38`), probe lock expiry (`src/lib/probes.js:234`),
a 16-character display slice (`src/lib/evidence.js:203`), and a `ts="…"` attribute
on restored messages (`src/lib/restore.js:124`). **No elapsed-time computation
exists anywhere except one probe-age render** (`src/lib/prompts.js:452-455`).

## Why this one is not optional

`best-goal-report.md:131` — the founding design document for this goal system —
specifies budgets that are on by default and runtime-enforced on *"turns, tokens
and wall-clock"*. Turns shipped (`maxContinuations`). Tokens shipped
(`tokenBudget`). Wall-clock did not.

The same report, at `:58`, convicts Codex of exactly this: *"`time_used_seconds`
is tracked but **never enforced anywhere** — wall-clock is a metric, not a
limit."* Bandaid is currently a step behind that: it does not even track it.

## The argument this brief has to win first

`src/lib/stamp.js:12-15` rejects time-based logic in as many words:

> A time-to-live would be wrong in both directions at once: it re-runs work
> nothing invalidated, and it trusts a result taken before the edit that broke
> it. A content fingerprint is exact.

That is correct and it is not about this. It is about **cache validity** — whether
a recorded result still describes this worktree — and for that question a content
hash genuinely is exact where a clock is a guess in both directions.

A wall-clock budget answers a different question: not *"is this still true"* but
*"how much of a finite resource is left"*. That is the question `tokenBudget`
already answers with a number nobody calls a heuristic, and elapsed wall-clock is
strictly better measured than `tokensUsed` is (see brief 5 — `tokensUsed` is a
systematic undercount, and no such objection applies to a clock).

`src/lib/selfcheck.js:58-60` makes a second, narrower rejection — timestamps must
not enter an expectation's *identity*, because then every re-record becomes a new
entry. Also correct, also untouched here.

**The invariant this brief adopts and brief 10 must not relax:** elapsed time may
gate a *budget*; it may never gate *validity*. Staleness stays content-hashed.

## Schema changes

### `meta.json` — new field

```jsonc
{ "startedAt": "2026-07-30T08:14:55.632Z", "turnIndex": 7, "pendingRestore": false }
```

Written once, on the first `UserPromptSubmit` for a session, in
`src/hooks/user-prompt-submit.js` beside the existing `bumpTurnIndex` call.
`store.updateMeta` is already a patch-bag (`src/lib/store.js:256`), so this needs
no migration — a session without the field falls back to `prompts.jsonl[0].ts`,
and a session with neither reports session age as unknown rather than as zero.

**Backfill:** `ledger.backfillFromTranscript` already rewrites the whole prompts
file and sorts by `ts` (`src/lib/ledger.js:46-51`); set `startedAt` from
`merged[0].ts` there when absent. `adoptPreviousLedger` (`:67`) must carry it
across a resume, or a resumed three-day session reports itself as newborn.

### `goal.json` — new fields

```jsonc
{
  "startedAt": "2026-07-30T08:16:17.029Z",   // == createdAt at birth; survives adoption
  "lastProgressAt": "2026-07-30T11:02:41.118Z",
  "continuationAt": ["2026-07-30T09:31:02.044Z", "…"],
  "timeUsedMs": 9_984_089,
  "timeBudgetMs": null
}
```

`startedAt` is deliberately distinct from `createdAt`: `goals.adoptHandoff`
(`src/lib/goals.js:456-483`) carries `createdAt` across sessions unchanged but
resets the continuation budget on purpose (*"a new day earns a new continuation
allowance"*). Time follows the budget, not the birthday — an adopted goal gets a
fresh `startedAt` and keeps `createdAt`, so "goal age" and "time spent this
session's allowance" are both answerable. `goal history` already shows the
multi-day chain and gains nothing from conflating them.

`lastProgressAt` is set on the same signals brief 7 will use for its refund, and
until brief 7 lands it is set on any non-trivial turn — i.e. wherever
`turnWasTrivial` (`src/lib/goals.js:387`) returns false. That is a deliberately
weak definition, it is documented as weak, and brief 7 replaces it.

`continuationAt[]` is capped at the last 8 entries. It exists so
"time per continuation" is computable without re-reading `turns.jsonl`, and it is
the input brief 4 uses when a goal has no task list.

### `config.js` — one new key

```jsonc
"goals": {
  "timeBudgetMs": null,   // wall-clock ceiling for one goal; null = unbounded
}
```

Default `null`, matching `tokenBudget` (`src/lib/config.js:56`). Env override
`BANDAID_TIME_BUDGET_MS` alongside the existing numeric parsers
(`src/lib/config.js:172`). A `--time-budget` flag on `goal set`, parsed as a
duration string (`90m`, `2h`, `5400000`) — the parser is small, tested, and
rejects rather than guesses on garbage.

## Enforcement

`goals.decideOnStop` (`src/lib/goals.js:510`), immediately after the existing
token-budget guard at `:530`:

```js
if (goal.timeBudgetMs != null && timeUsedMs(goal, now) >= goal.timeBudgetMs) {
  return { action: 'wrap-up', goal, reason: 'time budget exhausted' };
}
```

Routing to the existing `wrap-up` action is the whole point: it inherits
`budgetLimitPrompt`, the one extra blocking turn, and the `budget_limited` status,
with no new terminal state and no new prompt. `src/hooks/stop.js:90-100` needs
one change — the wrap-up path currently returns 0 silently unless
`tokenBudget != null`; it must also spend the wrap-up turn when
`timeBudgetMs != null`.

`decideOnStop` takes `now` as a parameter with a `Date.now()` default. It is a
pure function today and stays one; `test/goals.test.js` drives the branch with a
fixed clock.

## The render

One block, in three places, from one function — `elapsedSection(…, { now })` in
`src/lib/prompts.js`:

```
Elapsed:
- Now: 16:42 (Thu 30 Jul)
- This goal: 3h 18m of 6h
- Since last progress: 11m
```

Rules the render follows, because a time block is unusually easy to make useless:

- **Nothing that is not known is rendered.** No `timeBudgetMs` → the `of 6h`
  clause is absent, not `of unbounded`. No `startedAt` → the line is absent.
  This keeps the block byte-identical to nothing at all for anyone who has
  configured nothing, which is the same discipline `evidenceSummaryFor`
  (`src/hooks/stop.js:46-56`) already follows.
- **Coarse units.** `3h 18m`, not `3h 18m 04s`. A second-precision figure in a
  prompt invites arithmetic nobody needs and burns tokens on noise. Under a
  minute renders as `just now`.
- **Local time with the weekday, no timezone name and no year.** The weekday is
  the part that matters (is it still the day the user asked?); the offset is not.
- **Session elapsed is omitted from the continuation prompt** and appears only at
  `SessionStart`. Goal age is the number that changes a decision mid-work;
  session age mostly duplicates it and costs a line.

Three injection sites:

| Site | Function | Note |
|---|---|---|
| Continuation | `continuationPrompt` (`src/lib/prompts.js:225`) | Above `Budget:`; brief 5 later folds both into one line |
| Compaction restore | `buildRestoreBlock` (`src/lib/restore.js`) | Time of day + session age, so a post-compaction model is not stranded in the past |
| `SessionStart` | `src/hooks/session-start.js` | Time of day + session age + goal age if a goal is armed; this is the only place a no-goal session ever sees a clock |

## The expensive part: determinism

`test/prompts.snapshot.test.js:52` — *"nothing here may depend on the clock"* —
and 21 goldens depend on that holding. So every clock read arrives as an
injectable parameter down every call path, and the goldens pin a fixed `now`.

The idiom already exists and is exactly right. `probePendingPrompt` takes
`{ …, now = Date.now() }` (`src/lib/prompts.js:448`) and renders
`started ${seconds}s ago, budget ${…}s` at `:452-455`. That is the only
elapsed-time render and the only clock-reading prompt in the codebase. Copy it;
do not invent a second convention. `store.pruneSessions` (`:330`),
`ambiguousSessions` (`:437`) and `project.ageInDays` (`:145`) use the same
parameter form.

Threading required: `stop.js` → `continuationPrompt` → `elapsedSection`;
`session-start.js` → `buildRestoreBlock` → `elapsedSection`. Both hooks read the
clock exactly once per invocation and pass it down, so a hook cannot render two
different times in one output.

## Tests

| Test | Asserts |
|---|---|
| `test/goals.test.js` | `decideOnStop` returns `wrap-up` at the time budget; does not at 99% of it; ignores it when `null`; `timeUsedMs` survives adoption with a fresh `startedAt` |
| `test/prompts.snapshot.test.js` | New goldens `continuation-elapsed` and `continuation-elapsed-budgeted`, with ceilings. Existing 21 unchanged — a changed golden here means the block leaked into the no-config path |
| `test/store.test.js` | `meta.startedAt` written once and not overwritten by later prompts |
| `test/hooks.e2e.test.js` | Elapsed block reaches the model's stderr on a real `stop.js` run with a seeded goal; `BANDAID_TIME_BUDGET_MS` drives the wrap-up path end to end |
| new: duration parser | `90m`/`2h`/`5400000` parse; `soon`/`-5m`/`""` reject with a message |

Clock-moved-backwards is already a tested concern in this repo
(`test/project.test.js:261`, *"never goes negative on a clock that moved
backwards"*). Every elapsed computation here clamps at zero the same way.

## Measurement

A clock is not a verifier, so the honest measurement is narrow and stated as
such: **this brief is measured by whether the block renders correctly and costs
what it claims**, not by whether it makes the model better. Whether it earns its
tokens is brief 10's question, and brief 9 is what will answer it.

What ships with a number attached:

- Word count of the block at each of the three sites, recorded as ceilings.
- The delta to `continuation-bare`'s 800-word ceiling, in the commit message.
- `bandaid status` prints the time budget beside the existing verifier tier, so
  the configured state is inspectable rather than inferred.

## Honest limits (to be added to the README)

- **The clock is not always on.** It renders where Bandaid already spends tokens:
  a continuation, a compaction restore, and `SessionStart`. A session with no
  goal and no compaction sees the time once and never again. That is the cost of
  keeping the zero-steady-state property, and it was chosen deliberately over a
  per-turn injection costing ~35 tokens every turn.
- **`lastProgressAt` is coarse until brief 7.** It moves on any non-trivial turn,
  and a turn that edited a file while achieving nothing counts as progress. Brief
  7 replaces the definition; until then the "since last progress" line is closer
  to "since last edit".
- **An adopted goal's clock restarts.** `startedAt` resets on adoption so the
  time budget matches the fresh continuation allowance. Goal *age* across days is
  `createdAt` and is shown by `goal history`, not by this block.

## Files touched

`src/lib/config.js` · `src/lib/goals.js` · `src/lib/prompts.js` ·
`src/lib/restore.js` · `src/lib/store.js` · `src/lib/ledger.js` ·
`src/hooks/stop.js` · `src/hooks/session-start.js` ·
`src/hooks/user-prompt-submit.js` · `bin/bandaid.js` (`goal set --time-budget`,
`status`) · `README.md` · four test files · two new goldens
