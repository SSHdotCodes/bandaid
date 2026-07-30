# 2 — Per-batch duration, and a tool duration profile

## The failure

Nothing in Bandaid knows how long anything took.

`store.recordTurn` stamps one timestamp per batch, at the moment the record is
written (`src/lib/store.js:186-189`):

```js
function recordTurn(sessionId, record) {
  ensureSessionDir(sessionId);
  appendJsonl(turnsFile(sessionId), { ts: new Date().toISOString(), ...record });
}
```

An individual call record carries `name`, `input`, `result`, `failed`
(`src/lib/digest.js:118`) and nothing else. There is **no start time, no end time
and no duration for any tool call anywhere in the codebase**. `process.hrtime` and
`performance.now` do not appear at all.

The consequence: brief 4 wants to project a finish from observed work, and there
is nothing observed to project from. A `Bash` call that took 40 seconds and one
that took 40 milliseconds are the same record.

## Scope discipline

**This brief renders nothing.** It adds no prompt text, no config the model sees,
and no CLI output beyond one inspection command. It is the data layer for brief 4,
and it earns its place by being read there — not by being printed here.

That matters because the alternative is tempting and wrong: a "slowest tools this
goal" block is easy to write, reads as insightful, and would be the third block
added to the continuation prompt before anything has measured whether the first
two help. Brief 10 gets to make that call with a number.

## What to record

### Per batch

```jsonc
{
  "ts": "2026-07-30T08:16:18.198Z",     // unchanged: when the record was written
  "startedAt": "2026-07-30T08:16:12.030Z",
  "durationMs": 6168,
  "timing": "hook",                       // "hook" | "gap" | "none"
  "turnIndex": 1,
  "calls": [ … ]
}
```

> **Finding, recorded before implementation.** The brief below assumed the best
> available signal was the interval between batch completions. It is not. Claude
> Code's own transcript carries `assistant` entries whose `tool_use` blocks have a
> `timestamp`, and `user` entries whose `tool_result` blocks carry both a
> `timestamp` and a `sourceToolAssistantUUID` pointing back at the call. The
> difference is a **real per-call duration**.
>
> Measured against one real session before writing any code: **172 of 172
> `tool_use` blocks matched, zero negative durations**, and the distribution is
> plausible — `Read` p50 50ms, `Edit` p50 239ms, `Bash` p50 135ms with a 226s
> maximum (the test suite), `AskUserQuestion` 68s (a human deciding).
>
> So the derivation order below gains a tier, and the `gap` tier drops to a
> fallback rather than the main path. Two things this measures that it is easy to
> misread, both of which belong in the limits: an async tool like `Agent` records
> ~20ms because the *call* returns immediately while the work continues, and
> `AskUserQuestion`/`ExitPlanMode` measure how long a person took.

`timing` is the field that keeps this honest. Four derivations, in preference
order — `transcript` is the one that actually carries the work:

1. **`"hook"`** — `PostToolBatch` input carries timing directly. The payload shape
   is a product internal; if a start timestamp or duration is present, prefer it.
2. **`"transcript"`** — `tool_result.timestamp − tool_use.timestamp`, joined on
   `sourceToolAssistantUUID`. Per call, not per batch, and it measures the tool
   rather than the interval around it. This is the primary path. It cannot run at
   hook time — the transcript entry for a call does not exist until after the call
   resolves — so it is folded in lazily at Stop, deduped by a `syncedThrough`
   high-water mark since the transcript is append-only.
3. **`"gap"`** — delta from the previous batch's `ts` in the same session. This
   measures wall-clock between batch completions, which includes model thinking
   time and any user idle time. It is a *ceiling* on tool duration, not tool
   duration, and every consumer must treat it as such.
4. **`"none"`** — first batch of a session, or the previous record is missing or
   has an unparseable `ts`. `durationMs` is `null`. Never zero: a zero would be
   averaged into a profile and would quietly pull every estimate down.

Recording which derivation produced the number is the difference between a
measurement and a number. Brief 4's backtest segments by `timing` and reports
accuracy per derivation, because `gap`-derived data may well be too noisy to
estimate from — and if it is, that is a finding, not a bug.

### Per project: the profile

`~/.claude/bandaid/projects/<key>/durations.json`

```jsonc
{
  "updatedAt": "2026-07-30T16:42:00.000Z",
  "tools": {
    "Bash":  { "n": 412, "p50": 1830, "p95": 41200, "timing": { "hook": 0, "gap": 412 } },
    "Task":  { "n": 18,  "p50": 284000, "p95": 611000, "timing": { "hook": 0, "gap": 18 } },
    "Edit":  { "n": 96,  "p50": 210, "p95": 900,  "timing": { "hook": 0, "gap": 96 } }
  }
}
```

Percentiles, not means. One 40-minute `Task` call ruins a mean and barely moves a
p50, and the distribution of tool durations is exactly the long-tailed shape where
that matters. Stored as a rolling reservoir capped at 500 samples per tool so the
file cannot grow without bound and recent behaviour dominates.

Keyed by project rather than session, following `evidence.jsonl` and
`handoff.json` (`src/lib/project.js:84`) — a project's `Bash` calls are slow
because its test suite is slow, which is a property of the project and is the
whole reason the profile is worth keeping across sessions.

**GC:** follow `evidence.gc` (`src/lib/evidence.js:252`). A profile for a project
whose directory no longer exists is dropped by the same daily sweep that already
runs from `SessionStart` (`src/hooks/session-start.js:36-41`).

## Backfill

An existing session must not be blind. `readPromptsFromTranscript`
(`src/lib/transcript.js`) already reads Claude Code's own JSONL and maps
`entry.timestamp` → `ts` (`src/lib/transcript.js:84`). The same file carries tool
result entries with their own timestamps, which `transcript.js` currently filters
out deliberately. Add a second reader — not a change to the first — that walks
those entries for timing and produces `gap`-derived batch durations for history
Bandaid did not witness.

Backfill writes `timing: "gap"` and never `"hook"`, because a reconstructed
interval is exactly what `gap` means. Marking it otherwise would let brief 4
report accuracy for a derivation that never ran.

## Where the code goes

| File | Change |
|---|---|
| `src/hooks/post-tool-batch.js` | Read timing from input if present; else look up the previous batch's `ts`; write `startedAt`/`durationMs`/`timing`. Must stay under the 10s hook timeout and **must never exit 2** — `src/hooks/post-tool-batch.js:12` notes that aborts the agentic loop |
| `src/lib/store.js` | `lastTurnTs(sessionId)` — read one record backwards via the existing `readJsonlBackwards` (`:91`) rather than parsing the file |
| new `src/lib/durations.js` | The profile: `record(root, calls, durationMs, timing)`, `profile(root)`, `gc()`. Percentile computation and the reservoir live here |
| `src/lib/transcript.js` | A second reader for tool-result timings, additive |
| `bin/bandaid.js` | `bandaid inspect --durations` prints the profile. One inspection surface, no prompt surface |

The previous-batch lookup is the one performance risk: `post-tool-batch.js` runs
after every tool batch, and `turns.jsonl` is megabytes on a multi-day session.
`readJsonlBackwards` exists precisely for this (`src/lib/store.js:91`, already
used by `readTurnsSince` and tested for chunk boundaries and torn final lines at
`test/store.test.js`), so read one record backwards and stop.

## Tests

| Test | Asserts |
|---|---|
| `test/store.test.js` | `lastTurnTs` on an empty file, a one-record file, a file whose final line is torn, and across a read-chunk boundary — matching the existing `readTurnsSince` cases |
| new `test/durations.test.js` | p50/p95 on known samples incl. even and odd counts; reservoir caps at 500 and evicts oldest; `null` durations never enter a percentile; a tool seen once reports `n: 1` and no p95 |
| `test/hooks.e2e.test.js` | Two sequential `post-tool-batch.js` runs produce a `gap` duration on the second and `timing: "none"` on the first; a malformed previous `ts` yields `none`, not a crash and not a zero |
| `test/transcript.test.js` | The timing reader ignores the entries `readPromptsFromTranscript` already filters, and produces nothing rather than garbage on a transcript with no timestamps |

## Measurement

The measurement for this brief is not "is the profile useful" — that is brief 4's
question, answered by its backtest. It is **"is the profile correct"**, and it is
answered against ground truth this repo can manufacture:

Run a scripted session of known tool durations (`sleep 2`, `sleep 5`, `sleep 0.1`
through real `Bash` calls under the e2e harness), then assert the recorded p50 is
within tolerance of the truth. If `timing: "gap"` proves to include so much model
latency that a `sleep 2` records as 9 seconds, **that number goes in the README**,
because it is the number that tells brief 4 how much of its error is inherited.

Report: recorded-vs-actual for a scripted session, per derivation, plus the
observed fraction of batches that got `hook` timing versus `gap`. If `hook` timing
is unavailable in this Claude Code version, say so plainly — the feature still
works on `gap`, degraded, and the README should say by how much.

## Measured, as built

**Transcript derivation, against one real session** (`bandaid durations
--transcript <path>`):

```
  Edit               n=  77  p50     233ms  p95      286ms  max      304ms  transcript:77
  Bash               n=  46  p50     135ms  p95    20414ms  max   226818ms  transcript:46
  Read               n=  35  p50      48ms  p95       65ms  max       71ms  transcript:35
  Write              n=  16  p50     258ms  p95      307ms  max      307ms  transcript:16
  AskUserQuestion    n=   1  p50   68673ms  p95          —  max    68673ms  transcript:1
  ExitPlanMode       n=   1  p50   53032ms  p95          —  max    53032ms  transcript:1
```

- **196 of 196 calls matched, zero negative durations.** Every `tool_result`
  joined back to its `tool_use`.
- **Idempotent across three consecutive syncs** — 196 samples each time, so a
  stop that re-reads a growing transcript counts nothing twice.
- The numbers are plausible against known reality: `Bash` p50 135ms with a 226s
  maximum is the test suite; `AskUserQuestion` at 68s is a person deciding.

**`hook` timing was not observed.** No real `PostToolBatch` payload inspected
carried a duration or a start timestamp. The path is implemented and tested
against a synthetic payload, so it will be used if a future version supplies one,
but on this Claude Code version every real sample comes from the transcript.

**`gap` timing** is verified against a controlled 420ms interval in
`test/hooks.e2e.test.js` — recorded ≥ actual, never under. Its inflation on real
work is **not yet measured**, because the transcript path supersedes it and no
real session has produced a `gap` sample. If brief 4 ever needs to estimate from
`gap` data, that number has to be taken first.

**What this changes for brief 4:** the estimator's input is a genuine per-call
duration, not an interval containing model latency. The limit that carries over is
different from the one anticipated — it is not noise, it is *what the number
means*: an async tool records the time its call took to return, and a tool that
waits on a person records the person.

## Honest limits (to be added to the README)

- **`gap` timing is a ceiling, not a duration.** It measures the interval between
  batch completions, which contains the model's own thinking time. On a fast tool
  after a long deliberation it can overstate by an order of magnitude. Every
  consumer is required to segment by `timing` rather than average across it.
- **The profile is per project and per tool, not per call site.** A repository
  with one 4-minute test command and one 200ms linter has a bimodal `Bash`
  distribution that a p50 and a p95 describe badly. Splitting by command prefix is
  the obvious upgrade and is deliberately not built until something needs it.
- **500 samples per tool is a rolling window.** A project whose test suite got 10×
  faster today still reports yesterday's p95 for a while. That errs toward
  pessimism in the ETA, which is the safer direction.
- **Nothing here is shown to the model.** By design. If brief 10 finds the ETA
  earns nothing, this data layer has no independent justification and should go
  with it.

## Files touched

`src/hooks/post-tool-batch.js` · `src/lib/store.js` · new `src/lib/durations.js` ·
`src/lib/transcript.js` · `src/hooks/session-start.js` (gc) · `bin/bandaid.js` ·
`README.md` · `test/store.test.js` · `test/transcript.test.js` ·
`test/hooks.e2e.test.js` · new `test/durations.test.js`
