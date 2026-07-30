# 3 — The task ledger: reading `TodoWrite` back

## The failure

Bandaid tells the model to keep a task list current, then throws the answer away.

`TodoWrite` appears exactly twice in the entire codebase.

**Once as an instruction** (`src/lib/prompts.js:267-268`):

> Progress visibility:
> If the next work is meaningfully multi-step, use TodoWrite to show a concise
> plan tied to the real objective, and keep it current as steps complete.

**Once as a digest summarizer** (`src/lib/digest.js:99-102`):

```js
case 'TodoWrite': {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return clampLabel(todos.map((t) => `[${t.status || '?'}] ${t.content || t.activeForm || ''}`).join(' | '));
}
```

That flattens the whole list into one string, clamps it to 400 characters
(`MAX_LABEL_LEN`, `src/lib/digest.js:17`), stores it as a call's `input`, and never
parses it back. A ten-task plan becomes about six tasks' worth of text and a
truncation marker.

So Bandaid asks for a plan on every continuation, receives one, and cannot answer
"how many of these are done". There is no task count, no per-task timing, and no
notion of a task at all — the unit of decomposition in the goal record is
acceptance criteria (`src/lib/goals.js:225`), which are a fixed bar with no status
field and deliberately no percentage.

> **Finding, recorded before implementation.** `TodoWrite` does not appear in a
> single local transcript. This Claude Code surfaces **`TaskCreate` / `TaskUpdate` /
> `TaskList`** instead, and those carry what `TodoWrite` does not: a stable id.
>
> ```
> TaskCreate  input {"subject":"Author the ten plan briefs", "description":"…"}
>             result "Task #1 created successfully: Author the ten plan briefs"
> TaskUpdate  input {"taskId":"1","status":"in_progress"}
>             result "Updated task #1 status"
> ```
>
> So the identity problem that this brief calls "the whole brief" **does not exist
> on this path**. A task has an integer id, status transitions arrive one at a
> time, and a duration is an exact subtraction between two stamped events. No
> content hashing, no fuzzy rename rule, no threshold to measure.
>
> `TodoWrite` is still implemented, because `digest.js:99-102` has a summarizer for
> it and therefore it occurs in some configuration — and on that path every word
> below about matching still applies. But it is now the *secondary* path, and the
> fuzzy rule it needs is gated behind the measurement this brief already required
> rather than shipped on the assumption that it is the only option.
>
> One thing the id path costs: `TaskCreate` puts the id in its **result string**,
> not its input, so the ledger has to parse `Task #(\d+)` out of prose. That is
> brittle in a way an input field would not be, and it is the one place this path
> can silently stop working.

## What this brief is not

It does not make todo state authoritative. A criterion is the bar; a task is the
model's own working decomposition and the model can be wrong about it. The task
ledger is an *observation*, and every consumer treats it as one — brief 4 uses it
to estimate, brief 7 uses a completed task as one progress signal among several,
and nothing anywhere closes a goal because a todo list says it is done. That
distinction is the same one `evidence.append` enforces by forcing model-supplied
records to `claim`/`unverified` (`src/lib/evidence.js:79`).

## The hard part is identity

`TodoWrite` replaces the entire list on every call. Todos have no id. So matching
a task across two writes is a matching problem, and getting it wrong does not
produce an error — it produces plausible durations that are noise, which then
poison brief 4 silently. This is the whole brief; everything else is bookkeeping.

### What actually happens in practice

Five transitions have to be handled, and only the first is easy:

| Transition | What it looks like | Decision |
|---|---|---|
| Status change | Same `content`, `pending` → `in_progress` → `completed` | Match on content hash. Start the clock at first `in_progress`, stop at `completed` |
| Append | New entries at the end, existing untouched | New tasks, no duration yet |
| Reword | `Add retry logic` → `Add retry logic to client.js` | The interesting case — see below |
| Restructure | Ten tasks replaced by four differently-worded ones mid-work | Treat unmatched old tasks as **dropped**, not completed |
| Disappearance | A task present in write *n*, absent in *n+1*, never `completed` | **Dropped.** Never inferred as done |

The last row is the one that decides whether this data can be trusted. A task that
vanishes has, in every observed case, either been folded into another task or
abandoned — and inferring completion from absence would make every restructure
look like a burst of productivity. Brief 4 would then estimate from phantom
completions. So: absence is `dropped`, and `dropped` tasks are excluded from
duration statistics entirely rather than counted as fast.

### Matching rule

1. **Exact content hash** — `ledger.fingerprint` (`src/lib/ledger.js:14`, sha1
   truncated to 16) over the normalized `content`. Normalization: trim, collapse
   internal whitespace, lowercase. Not more than that; stemming a task title is
   how "write the test" and "wrote the tests" become the same task and a duration
   becomes fiction.
2. **Positional + prefix fallback for rewords** — an unmatched new task at index
   *i* matches an unmatched old task at index *i* when one normalized content is a
   prefix of the other, or their token-set overlap exceeds a threshold. This is a
   heuristic and is labelled one: matched-by-fallback tasks record
   `matchedBy: "fuzzy"`, and brief 4's backtest can exclude them to see whether
   they help or hurt.
3. **No match** — a new task. An old task that ends the write unmatched and not
   `completed` is `dropped`.

The token-overlap threshold is not guessed. `README.md:711-713` records that
consecutive judge reasons sat at 0.2–0.7 token overlap with *no* threshold
separating "stuck" from "progressing" — a direct warning that this repo has
already been burned by exactly this kind of number. So the threshold is chosen by
measurement against the fixture corpus below, reported, and if no threshold
separates rewords from genuinely-new tasks then **rule 2 is dropped** and rewords
count as new tasks. That is an acceptable outcome, recorded as one.

## Storage

`~/.claude/bandaid/sessions/<id>/tasks.jsonl` — append-only, one record per
observed state change, never rewritten:

```jsonc
{"ts":"2026-07-30T09:31:02.044Z","taskId":"a41f2c8e91b3d004","turnIndex":7,
 "content":"Add exponential backoff to client.js","status":"in_progress",
 "matchedBy":"exact","event":"status"}
{"ts":"2026-07-30T09:47:55.310Z","taskId":"a41f2c8e91b3d004","turnIndex":9,
 "content":"Add exponential backoff to client.js","status":"completed",
 "matchedBy":"exact","event":"status","activeMs":1013266}
```

Append-only matters: the file is the audit trail for a matching decision that is
partly heuristic, so a wrong match must be *inspectable* rather than overwritten.
`store.appendJsonl` (`src/lib/store.js:44`) is the existing primitive.

Derived state is computed on read, never stored:

```js
tasks.state(sessionId)
// → { total: 10, completed: 6, inProgress: 1, pending: 3, dropped: 2,
//     durations: [1013266, 284000, …], matchedFuzzy: 1 }
```

Note `total` excludes `dropped` — a plan that was restructured did not have
sixteen tasks. `dropped` is reported separately so the restructure is visible
rather than hidden.

## Where the code goes

| File | Change |
|---|---|
| `src/hooks/post-tool-batch.js` | Detect a `TodoWrite` call in the batch and hand its raw `input.todos` to the ledger **before** `digest.js` flattens it. This is the only place the unflattened list is available |
| new `src/lib/tasks.js` | `observe(sessionId, todos, turnIndex, now)`, `state(sessionId)`, the matcher, and the normalizer |
| `src/lib/digest.js` | Unchanged. The 400-char label is fine for what it is — a human-readable digest — and rewriting it would churn goldens for nothing |
| `src/lib/ledger.js` | `adoptPreviousLedger` (`:67`) copies `tasks.jsonl` alongside `prompts.jsonl` and `turns.jsonl`, or a resumed session loses its task history |
| `bin/bandaid.js` | `bandaid inspect --tasks`. No prompt surface in this brief |

`post-tool-batch.js` must stay inside its 10s timeout and must never exit 2
(`src/hooks/post-tool-batch.js:12`). The matcher runs over at most a few dozen
todos and reads at most the last state from `tasks.jsonl` backwards — bounded work.

## One thing that stays as it is

`TodoWrite` is **absent** from `MUTATING_TOOLS` (`src/lib/goals.js:25-34`), so a
turn that only moved the todo list is `turnWasTrivial` and the stop is allowed
(`src/lib/goals.js:538`). That is correct and deliberate: updating a plan is not
doing the work, and the continuation prompt says so in as many words — *"do not
treat a plan update as a substitute for doing the work"* (`src/lib/prompts.js:268`).

This brief must not change it. Adding `TodoWrite` to `MUTATING_TOOLS` would let a
model hold a turn open by editing its plan, which is precisely the loophole the
omission closes. The reasoning is recorded here so a later reader does not
"fix" the omission into a bug.

## Tests

A fixture corpus of `TodoWrite` sequences, each with hand-computed expected state.
The corpus is the deliverable as much as the code is:

| Fixture | Sequence | Expected |
|---|---|---|
| `linear` | 3 tasks, each pending → in_progress → completed in order | 3 total, 3 completed, 3 durations, 0 fuzzy |
| `append` | 3 tasks, then 2 appended mid-run | 5 total, no spurious drops |
| `reword` | task 2's content extended in place | 3 total, 1 `matchedBy: "fuzzy"`, duration preserved across the reword |
| `restructure` | 10 tasks replaced by 4 unrelated ones at turn 5 | 4 total, 10 dropped, dropped excluded from durations |
| `regression` | a `completed` task returns to `in_progress` | Handled without a negative duration; second interval recorded separately |
| `duplicates` | two tasks with identical content | Disambiguated by position; not collapsed into one |
| `garbage` | `todos` absent, `null`, a string, entries with no `content` | No crash, no records, no zero durations |

Plus `test/hooks.e2e.test.js`: a `post-tool-batch.js` run with a real `TodoWrite`
payload produces the expected `tasks.jsonl`, and a resume carries it.

## Measurement

**Matching accuracy against the corpus, reported as a number**, and specifically
the fuzzy rule's contribution: run the corpus with rule 2 on and off and report
both. If rule 2 does not improve matching on `reword` without damaging
`duplicates` and `restructure`, it does not ship — a heuristic that costs
correctness on two fixtures to help one is worse than not having it.

Second number: the fraction of real sessions in which the model uses `TodoWrite`
at all. If it is low, brief 4's ETA has no input most of the time and must fall
back to `continuationAt[]` from brief 1 — which is worth knowing before brief 4 is
written, not after.

## Measured, as built

**Against ground truth.** This session's real `TaskCreate`/`TaskUpdate` calls,
replayed out of the transcript:

```
total=11 completed=3 inProgress=1 pending=7 dropped=0
durations: 702s, 1351s, 625s        (12m, 23m, 10m)
fuzzy: 0
  [completed] Author the ten plan briefs in docs/plans/          (12m)
  [completed] Plan 1 — the clock and a wall-clock budget         (23m)
  [completed] Plan 2 — per-batch duration and a tool profile     (10m)
  [in_progress] Plan 3 — the task ledger
```

Every figure checks out against what actually happened, nothing was guessed, and
no task was wrongly dropped.

**The matcher, on the corpus.** 20 tests, all passing. Two bugs the corpus caught
before anything shipped, both of which would have produced confident wrong numbers:

- **Jaccard alone cannot see a reword.** "Add retry logic" → "Add retry logic to
  the client" scores **0.5**, below any threshold that also rejects "Update the
  docs" against "Update the parser generator config" (0.33). So the rule is a
  word-boundary prefix test *first*, with overlap ≥ 0.6 as a fallback — no
  threshold has to separate the two cases, which is what
  `README.md:711-713` warns is impossible on data like this.
- **Two identically-worded tasks collapsed into one**, because content was the
  whole identity. Now disambiguated by occurrence index within the list.

**The number that changes brief 4.** Across 15 local sessions:

```
  used TaskCreate/TaskUpdate:  1  (7%)
  used TodoWrite:              0  (0%)
  used neither:               14  (93%)
```

**A task list exists for 7% of sessions, and the one that has it is this one.**
So a task-count ETA has no input almost all of the time, and brief 4's
`continuationAt[]` fallback is not a fallback — it is the main path. Brief 4's
headline claim has to be worded accordingly.

Caveat on that number, because it is doing a lot of work: 15 sessions, one user,
one project, most of them short. Task-tool use is also prompted by a harness
reminder, so long agentic sessions will over-represent it relative to this sample.
7% is what was measured, not a general rate.

## Honest limits (to be added to the README)

- **A task list is the model's own account of its plan, not ground truth.**
  Nothing closes a goal because a todo said `completed`; the criteria and the
  evidence ledger remain the only bar. A model that marks everything done marks
  nothing proven.
- **Matching across a reword is a heuristic.** Records carry `matchedBy` so a
  wrong match is visible, and `tasks.jsonl` is append-only so it is recoverable.
  Every duration derived from a fuzzy match is excludable and is excluded from the
  backtest's headline number.
- **A vanished task is recorded as dropped, never as done.** So a model that
  restructures its plan instead of completing it shows as low completion, which is
  the accurate reading and will occasionally be unflattering.
- **No ETA lives here.** Task counts alone say nothing about time remaining; brief
  4 combines them with brief 2's durations, and only ships if the result beats a
  trivial baseline.

## Files touched

`src/hooks/post-tool-batch.js` · new `src/lib/tasks.js` · `src/lib/ledger.js` ·
`bin/bandaid.js` · `README.md` · new `test/tasks.test.js` (with the corpus) ·
`test/hooks.e2e.test.js`
