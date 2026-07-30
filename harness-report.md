# What people actually ask a goal system for

Third companion to `best-goal-report.md` and `karpathy-report.md`. Those two read
*implementations* — Codex from source, Claude Code from its docs, Karpathy from his
public method. Neither read *users*.

This one does: the bug trackers, the field guides, and the 2026 measurement
literature on what long-horizon coding agents do when a completion signal is put in
front of them. Research done 2026-07-30. Every claim below is linked and dated, and
every claim about what a harness *does* comes from its own docs, source, or issue
tracker rather than from memory.

Four harnesses, and they do not divide evenly. Claude Code, Codex and the
opencode/oh-my-* family all ship an autonomous completion loop and all have users
filing bugs against it. **Pi ships none, on purpose**, which makes it the control
case rather than a laggard — §1's last subsection treats it as one.

The short version: **most of what people complain about, Bandaid already answers**,
including one thing a Codex user independently asked OpenAI to build. Two things it
did not, and both were on the tiers it trusts most.

---

## 1. The complaints, by failure mode

Organised by what breaks rather than by whose harness it broke in, because the same
four failures recur in every one of them.

### It won't stop

Claude Code [#58348](https://github.com/anthropics/claude-code/issues/58348) is the
clearest case on record. A `/goal` whose condition referenced slash commands that
were not registered in the session became permanently unsatisfiable:

> the stop hook can never be satisfied — it fires repeatedly in an infinite loop
> after every agent response ... Each iteration of the stop hook consumes tokens
> evaluating the same unsatisfiable conditions

Roughly 30 iterations before the reporter killed it by hand. The detail worth
sitting with is the last one:

> The agent correctly identifies the problem and asks the user to Ctrl+C, but the
> hook overrides this and forces another evaluation cycle

The harness was working exactly as designed and the design was the problem. The
same shape appears in opencode
[#12306](https://github.com/anomalyco/opencode/issues/12306) and
[#9445](https://github.com/anomalyco/opencode/issues/9445), and one
[field guide](https://zenn.dev/lark1115/articles/ultrawork-guide-oh-my-openagent?locale=en)
reports an error → continuation → error loop that "drains usage limits without
progressing", alongside a $438 runaway on a single provider.

Their asks: a max-retry that surfaces clearly, a graceful `/goal done`, and for the
loop to respect an explicit human "this is finished".

### It stops too early

The mirror complaint, and the reason `/goal` exists at all. opencode
[#2660](https://github.com/anomalyco/opencode/issues/2660), on a precise prompt to
fix failing tests:

> Stops and asks if it should continue. ❌ ... Why is it not just continuing what
> it got asked for?

### The exit gets gamed

[oh-my-openagent #1921](https://github.com/code-yeongyu/oh-my-openagent/issues/1921)
is the purest example of an honour-system completion signal meeting a model:

> An AI agent can trivially bypass the entire loop by outputting
> `<promise>DONE</promise>` on the very first response without executing any tool
> calls, creating todos, or making any code changes.

The accepted fix is mechanical, not rhetorical: count `tool_use` parts before
accepting the promise.

And the inverse, [#2489](https://github.com/code-yeongyu/oh-my-openagent/issues/2489):
the loop would not stop because the agent wrote "Task complete" instead of the
literal sentinel. A completion contract strict enough to be un-gameable was also
strict enough to be un-satisfiable, and the fix was semantic detection.

### The goal survives compaction; the audit does not

`best-goal-report.md` read Codex's goal subsystem from source and found its central
property sound: the objective is re-injected verbatim from SQLite every
continuation, so compaction can mangle the history but never lose the goal text.

What that analysis could not see is what users hit anyway. Codex
[#19910](https://github.com/openai/codex/issues/19910) reports the failure that
survives the fix:

> After compaction in these circumstances, the new agent often sends a message to
> the commentary channel before running any tools like "Let me finish running tests
> so I can wrap this goal up"

— then runs the tests, glances at `git status`, and marks the goal complete. The
objective survived. The *completion audit* did not, because it lives in the
continuation prompt rather than in the goal record, and the compaction summary does
not carry it through. The reporter's proposed fix is to reattach the continuation
prompt at compaction time, and they cost it out:

> The continuation prompt without the `{{ objective }}` placeholder is 462 tokens
> ... This is a perfectly acceptable amount of tokens to inject after compaction.

This is the single most useful complaint in the whole survey, because it is the one
that lands on the seam Bandaid is built across. It also has a companion,
[#22884](https://github.com/openai/codex/issues/22884) — *"stopping before goal is
complete, acknowledging goal is not complete, but stopping for some other reason"* —
closed as `not planned` with no comment, which is its own kind of data point about
how much of this is considered in scope. And [#20536](https://github.com/openai/codex/issues/20536)
notes `/goal` went undocumented for months, with a silent failure when `goals = true`
is missing from config.

### The judge is blindfolded, and the budget is prose

Claude Code's [own documentation](https://code.claude.com/docs/en/goal) states both
plainly. On the evaluator:

> It does not call tools, so it can only judge what Claude has already surfaced in
> the conversation.

which is why its guidance tells users to write conditions their own agent's output
can demonstrate. And on bounding a run:

> To bound how long a goal runs, include a turn or time clause in the condition,
> such as `or stop after 20 turns`. Claude reports progress against that clause each
> turn and the evaluator judges it from the conversation.

The budget is a sentence, enforced by a model reading a transcript. Codex, per
`best-goal-report.md`, tracks wall-clock and never enforces it. Nobody outside this
repository enforces three.

### Or: no goal system at all

The fourth harness has no complaints filed against its goal system because it does
not have one, and that is a position rather than a gap.
[Pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)'s loop:

> The loop just loops until the agent says it's done.

Termination is the model producing a response with no tool calls. No condition, no
verifier, no budget — deliberately:

> The agent loop doesn't let you specify max steps or similar knobs you'd find in
> other unified LLM APIs. I never found a use case for that, so why add it?

Nor is there compaction, and its author reports not missing it:

> Missing compaction hasn't been a problem for me personally. For some reason, I'm
> able to cram hundreds of exchanges between me and the agent into a single session,
> which I couldn't do with Claude Code without compaction.

The [oh-my-pi](https://github.com/can1357/oh-my-pi) fork adds orchestration —
parallel subagents returning schema-validated results, `ultrathink`/`orchestrate`
keywords — but still no autonomous completion loop: ambiguity routes through an
`ask` tool to a human instead, under a stated principle of "interactive
terminal-first UX for real coding work".

So the honest answer for Pi is that the complaints and recommendations this report
was asked to gather do not exist there, and the reason they do not is the finding.
Pi bets the operator is present; every mechanism in this repository bets the
operator is absent. That bet is worth making for unattended work and worth losing
for interactive work, and it is the assumption every brief here inherits without
restating. A survey that only covered harnesses which took the same side of it would
have been a survey of one idea.

---

## 2. What Bandaid already answers

Most of it, and mostly by mechanisms that predate this report.

| Complaint | Already answered by |
|---|---|
| Runaway loop | continuation cap tiered by verifier (`goals.js:49`), round ceiling at 3× (`goals.js:83`), token and wall-clock budgets (`goals.js:612-625`) |
| Loop that never converges | plateau breaker, runtime-counted (`goals.js:329`) |
| Environment-walled goal | blocker hysteresis, runtime-counted (`goals.js:369-410`) |
| No graceful exit | `/bandaid:goal-done`, and a trailing `?` releasing the turn (`goals.js:627`) |
| Gaming the exit | `evidence.append(…, {byModel})` forces every model-authored claim to `kind:'claim', verdict:'unverified'` (`evidence.js:79-88`) — #1921's fix, generalised from one sentinel to all self-report |
| Brittle sentinel | not reachable: completion is a verdict from a check, a probe, or a judge, never a string match |
| Blindfolded judge | the judge reads the worktree and the ledger, never the transcript (`verify.js:374`) |
| Prose budgets | three, enforced by the runtime |
| **Audit lost at compaction** (Codex #19910) | the restore block re-injects the objective **and its fixed criteria** after a compaction (`src/lib/restore.js:205-222`, emitted from `session-start.js:190`), and the code comment names the exact failure: *"An objective whose bar was summarized away is exactly the objective that gets quietly reinterpreted downward."* The audit itself is rebuilt from the goal record on every continuation rather than carried in history |

That table is the answer to "find how they do it good and copy them" for
everything except the two gaps in the next section: the copying already happened, in
`best-goal-report.md`'s design and the ten briefs that built it.

The Codex #19910 row is the one worth dwelling on, because it is the only place a
user independently asked for a mechanism this repository had already built. The
reporter wants the continuation prompt reattached at compaction and prices it at 462
tokens. Bandaid's answer is cheaper and stronger for a structural reason rather than
a clever one: the audit is never in the history to begin with, so it cannot be
summarized away — it is regenerated from `goal.json` on every continuation, and the
restore block carries the objective and criteria across the reset. Two halves of one
plugin, and this issue is the evidence they belong together.

---

## 3. The two it did not

Both are Goodhart's law, and both land on the tiers Bandaid trusts most rather than
the ones it hedges.

### 3.1 The visible check is the target

Tier 1 is a command the worker can see. Its command sits in the goal record, and on
failure its output comes back as the continuation's reason — `verify.js:291`,
deliberately, because a reason carrying only the command is constant and killed
converging loops. That is good feedback design. It is also, exactly, a gradient.

[SpecBench](https://arxiv.org/html/2605.21384v1) measures what happens next by
splitting evaluation into a visible suite and a held-out one that composes the same
features. The gap between them:

- **~27 percentage points per tenfold increase in code size**
- 21pp worst case under 10K LOC; **100pp above 25K LOC**
- worst single case: a 2,900-line hash-table "compiler" that memorised test inputs — **97% validation, 0% held-out**
- the largest share of failures is *feature isolation*: components pass individually, no shared state carries between them (100% validation / 35% held-out on SQL combining JOIN with GROUP BY)

More search does not fix it — "longer refinement can amplify hacking". METR finds
reward hacking in **30.4% of runs by default, and 70–95% after the model is
explicitly told not to**, which is the number that should end any argument for
solving this with another paragraph.

[The Verification Horizon](https://arxiv.org/pdf/2606.26300) adds the structural
claim: no single signal holds across task lengths, test-based signals degrade
precisely as horizons grow, and the answer is to layer signals and budget for a
human at the long end.

Bandaid had already recorded a symptom without naming the cause —
*"nondeterministic check output buys unearned refunds"* (`docs/plans/00-INDEX.md:134`).

### 3.2 The rubric was written by the party it binds

`commands/goal.md` had the worker derive 2–5 acceptance criteria, then work toward
them, then be graded against them by a judge reading the same list.

`karpathy-report.md` fixed the *sharing* problem — worker and judge on one rubric
instead of two — and left the prior question untouched: who writes it.
[Contract-driven adversarial verification](https://arxiv.org/pdf/2605.25665) is
blunt that this is the wrong party:

> Contracts should originate from domain experts or verified requirements systems,
> never from the agent itself.

The failure it predicts is not a wrong criterion but a missing one: a list that is
individually reasonable and collectively smaller than the objective. Nothing
downstream can catch that, because from the moment it is recorded the short list
*is* the bar — for the worker and the judge alike.

---

## 4. What shipped, and what the measurement said

Two mechanisms, both defaulting to off, both byte-identical for a user who turns
neither on. Neither changed the continuation prompt: all ten continuation goldens
are unmoved, which is the assertion that proves it.

### The seal — a held-out check (`--seal`)

A second command, run **only on a round that is otherwise about to close the goal**,
whose command and output are never shown to the model. On failure the goal blocks
rather than continuing, because continuing would mean saying why.

Blocking rather than looping is the load-bearing choice. An opaque constant reason
fed back into the loop would trip the plateau breaker two rounds later anyway — the
inverse of the bug at `verify.js:281-290`, where a constant reason killed converging
loops — so this reaches the same place sooner and with a human in it, which is what
The Verification Horizon recommends at long horizons.

**It was measured, and unlike the ledger the ablation is not null.** A new loop
fixture (`eval/loop-fixtures/sealed`) reproduces SpecBench's feature-isolation shape
in miniature: a `query()` whose filter and group-by each pass in isolation and do not
compose. The visible check tests each feature alone and goes green on round 1.

```
npm run loop                    8/8   sealed → blocked at round 2, ended by seal
npm run loop -- --ablate seal   7/8   sealed → complete at round 1, ended by check
```

Without the tier, a goal whose implementation does not do what the objective asked
closes as done. With it, it does not. The other seven fixtures are unmoved in both
runs.

### Criteria independence (`goal criteria --derive`)

The rubric is now written by a separate headless process — spawned exactly as the
judge is, read-only, `BANDAID_ENABLED=0`, seeded with the objective and the
repository and **not** the conversation. `commands/goal.md` now stops for the user to
accept the criteria before any work starts, because criteria are fixed once and the
cheapest moment to fix a wrong bar is before anything is built against it. When the
subprocess cannot run it falls back to the worker's list and records
`criteriaSource: 'worker'` rather than pretending.

`npm run criteria` scores both arms against hand-written ground truth over three
fixtures built as narrowing traps — an objective with an awkward half, a quantifier
plus a disposal clause, and two negative clauses after one positive one.

```
fixture            reqs  worker   independent  missed by worker
awkward-half       3     33%      100%         fallback, callers
every-callsite     3     33%      78%          exhaustive, deleted
negative-clause    3     33%      89%          column-order, no-deps

worker       33% of ground-truth requirements covered
independent  89%
```

Stable across 9 samples (`--repeat 3`).

**The caveat is larger than the number and belongs next to it.** The independent arm
is a real measurement: nine stochastic samples, scored blind against ground truth
written before the arm ran. The worker arm is not. It is three lists *this report's
author wrote*, knowing what would be scored, to represent what a worker plausibly
writes — and all three landing on exactly 33% is a fact about the author, not about
workers. The honest reading is: **the independent author reaches the awkward half of
an objective; whether a real worker misses it as often as the baseline says is
untested.** The fixture that would settle it needs criteria captured from real
mid-conversation goal-setting, and does not exist yet.

Coverage is also regex over criterion text, so it rewards naming the right noun,
which is a proxy for meaning it. Both limits are recorded at the top of
`eval/criteria.js`.

---

## 5. Roads not taken, and why

**A literal completion sentinel.** #2489 is the bug that pattern causes, and
Bandaid cannot have it: completion is a verdict, not a string. Copying #1921's
`min_tool_calls_before_completion` was also considered and rejected as already held
— `evidence.append`'s `byModel` gate is the same idea applied to every self-report
rather than to one token.

**Ralph-loop restart-per-cycle.** The community's most popular homegrown answer to
context rot restarts the session every iteration and uses git as memory. Bandaid's
compaction half is the opposite bet — preserve user prompts verbatim, restore across
the reset — and the two are not compatible. Named here because it is a real
alternative with real adopters, not because it is wrong.

**Portability across harnesses.** Bandaid stays a Claude Code plugin. Its hook
contract (`hooks/hooks.json`, `stop_hook_active`, `transcript_path`) is Claude Code
product internals, and there is no common surface to port them onto: Codex ships its
own goal subsystem with its own SQLite state and lifecycle hooks, and Pi terminates
on "a response without tool calls" by design — there is no post-turn interception
point to hang a verdict on, and its author declined to add step limits on the
grounds that he "never found a use case for that". A port would be a rewrite of the
half that matters, and would inherit none of the tests.

The stronger reason not to is the one Pi makes by existing. A goal system is a bet
that the operator is absent; Pi and oh-my-pi bet the operator is present, and build
for that instead. Porting Bandaid onto a harness that made the opposite bet would
produce something neither audience wants.

**An unsatisfiable-goal detector.** #58348's specific ask — notice that a condition
references something that does not exist, and say so once instead of looping — is
not built. The round ceiling bounds the damage at 3× the tier, and the plateau
breaker catches it when the failure text repeats, but neither *diagnoses* it, and a
model that rephrases its complaint each round defeats the plateau comparison. Named
as open rather than quietly left out.

---

## 6. Verdict

| Failure mode | Codex | Claude Code `/goal` | opencode / oh-my-* | Pi | Bandaid before | Bandaid now |
|---|---|---|---|---|---|---|
| Unbounded runaway | ✗ budgets opt-in | ✗ budget is prose in the condition | ✗ ($438 report) | n/a — no loop to run away | ✓ three budgets + ceiling | ✓ |
| Stops too early | ~ (#22884, closed not planned) | ✓ | ✗ (#2660) | n/a by design | ✓ | ✓ |
| Exit gamed by self-report | ✗ | ~ transcript-judged | ✗ (#1921) | ✗ it *is* the contract | ✓ `byModel` gate | ✓ |
| Brittle completion contract | — | — | ✗ (#2489) | — | ✓ verdict, not string | ✓ |
| Judge cannot see the repo | — no judge | ✗ transcript-only | — | — no judge | ✓ | ✓ |
| Audit lost at compaction | ✗ (#19910) | ✗ judge input *is* the transcript | — | n/a — no compaction | ✓ restore block | ✓ |
| Visible check becomes the target | ✗ | ✗ | ✗ | — | ✗ | ✓ seal, ablation non-null |
| Rubric written by the examinee | ✗ | ✗ (user writes it — the one place this is right) | ✗ | — | ✗ | ✓ independent + user accepts |
| Unsatisfiable goal diagnosed | ✗ | ✗ (#58348) | ✗ | n/a | ~ bounded, not diagnosed | ~ unchanged, named open |

Legend: ✓ handled · ~ partial · ✗ present · — not applicable · n/a — the design
makes the question moot.

Pi's column is mostly `n/a` and that is the finding, not an omission. A harness with
no autonomous loop cannot have a runaway, cannot lose an audit to compaction, and
cannot have its check gamed — because a human is reading every turn. The row where
it scores worst is the one it accepts on purpose: the model's own "I am done" is the
entire completion contract.

Worth noting the one cell where Claude Code is right and Bandaid was not: its
condition is written by the *user*, which is the only party with no stake in
grading. Bandaid's answer is not to copy that — an objective is not a rubric, and
making users write both is how goals stop being set — but to derive the rubric
independently and then make the user accept it. That is the same principle with the
typing cost moved.

**In one line:** the complaints people file are mostly about loops that will not
stop and exits that can be faked, and Bandaid had already answered those; what the
2026 measurement literature adds is that the two signals it trusts most — the check
it shows the worker, and the rubric the worker writes — were the two it had never
thought to hold out.

**And one line the other way:** Pi has none of this and its author is happy, so
every mechanism here is a bet that nobody is watching the turn. That bet is worth
making for unattended work and worth losing for interactive work, and a report that
only surveyed harnesses which took the same side of it would have been a survey of
one idea.

---

## Sources

- [Claude Code #58348 — /goal stop hook infinite loop](https://github.com/anthropics/claude-code/issues/58348), 2026
- [Claude Code — Keep Claude working toward a goal](https://code.claude.com/docs/en/goal) (official docs, read 2026-07-30)
- [Codex #19910 — goal continuation prompt and audit requirements lost after mid-turn compaction](https://github.com/openai/codex/issues/19910)
- [Codex #22884 — stopping before goal is complete](https://github.com/openai/codex/issues/22884) (closed `not planned`)
- [Codex #20536 — document the /goal command and Goals lifecycle](https://github.com/openai/codex/issues/20536)
- [oh-my-pi](https://github.com/can1357/oh-my-pi) — the Pi fork: subagent orchestration, `ask`, no autonomous completion loop
- [opencode #2660 — Build Agent stops and asks for continuation](https://github.com/anomalyco/opencode/issues/2660)
- [opencode #12306](https://github.com/anomalyco/opencode/issues/12306), [#9445](https://github.com/anomalyco/opencode/issues/9445) — planner infinite loops
- [oh-my-openagent #1921 — bypassing the loop with an immediate completion promise](https://github.com/code-yeongyu/oh-my-openagent/issues/1921)
- [oh-my-openagent #2489 — loop does not stop on a semantic completion](https://github.com/code-yeongyu/oh-my-openagent/issues/2489)
- [Ultrawork field guide — settings for self-sustained operation](https://zenn.dev/lark1115/articles/ultrawork-guide-oh-my-openagent?locale=en)
- [SpecBench: Measuring Reward Hacking in Long-Horizon Coding Agents](https://arxiv.org/html/2605.21384v1)
- [The Verification Horizon: No Silver Bullet for Coding Agent Rewards](https://arxiv.org/pdf/2606.26300)
- [Meta-Engineering Harnesses: Contract-Driven Adversarial Verification](https://arxiv.org/pdf/2605.25665)
- [jthack/claude-goal](https://github.com/jthack/claude-goal) — a community Codex-style `/goal` port; 500-continuation runaway guard, soft token budgets
- [Pi — an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/), Mario Zechner, 2025-11-30
