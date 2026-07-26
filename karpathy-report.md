# Karpathy's method, applied to Bandaid

Companion to `best-goal-report.md`. That report asked *who should grade the goal*.
This one asks a prior question: **where should the effort go at all?** — and finds
that Bandaid, like Codex before it, has been spending it in the wrong place.

Sources are dated and quoted in §1. Measurements in §3 were taken against the
working tree on 2026-07-26 at 14:0x, `npm test` green at 87 tests.

---

## 1. The method

Karpathy's public position on getting work out of an LLM is not a prompt style.
It is an engineering discipline with four load-bearing claims.

**1.1 Context engineering, not prompt engineering.** (@karpathy, 25 Jun 2025)

> +1 for "context engineering" over "prompt engineering". People associate prompts
> with short task descriptions you'd give an LLM in your day-to-day use. When in
> every industrial-strength LLM app, context engineering is the delicate art and
> science of filling the context window with just the right information for the
> next step.

The operative phrase is **"for the next step"**. Not the most recent information,
not the most information — the *right* information. Too little and the model
lacks what it needs; too much irrelevant and you degrade the result. Both
directions are failures, and only one of them is obvious.

**1.2 The LLM-OS framing.** The LLM is the CPU, the context window is RAM, and
persistent memory is disk. Anything you need to survive a context reset has to be
written to disk, because RAM is not durable. This is why Karpathy's diagnosis of
agents in the Dwarkesh interview (Oct 2025) is architectural, not a scaling
complaint:

> they cannot plan, they cannot remember, and their knowledge is pre-compiled
> instead of compounding

**1.3 Ask for success, because the model isn't trying to succeed.** (State of GPT,
Microsoft Build 2023)

> LLMs don't want to succeed. They want to imitate. You want to succeed, and you
> should ask for it.

The model's objective is to produce a plausible continuation of the transcript. A
plausible continuation of "the engineer finished the task" is "the engineer says
they finished the task." Nothing in the objective distinguishes that from actually
having finished. Laziness is not a character flaw to be scolded out of the model;
it is the training objective working correctly.

The same mechanism explains hallucination. Karpathy's framing is that LLMs are
"dream machines" and confabulation is not a bug —

> It looks like a bug, but it's just the LLM doing what it always does.

— which means you do not fix it by asking for accuracy. You fix it by putting
something in the loop that is not the model.

**1.4 The generation-verification loop, and the autonomy slider.** This is the
part that turns 1.3 into a design. Karpathy's three rules:

> Keep the AI on a leash.

> Maximize the speed of the generation-verification loop.

> Write a verifier, bound the retries, put it on a trigger, and slide autonomy up
> as the verifier proves out.

The consequence is a claim about where engineering effort pays: **throughput is
set by verification speed, not by prompt length.** Make verification cheaper
before you make prompts longer. Autonomy is not a setting you choose; it is a
privilege a verifier earns.

His fourth coding principle is the same claim aimed at goals:

> Define success criteria and loop until verified. Transform "fix the bug" into
> "write a test that reproduces it, then make it pass."

> LLMs are exceptionally good at looping until they meet specific goals. Do not
> tell it what to do. Give it success criteria and watch it go.

---

## 2. Where Bandaid already agrees

More than it realises. Four of Karpathy's positions are already implemented here,
in some cases better than in the systems he was describing.

| Karpathy | Bandaid |
|---|---|
| Context engineering: preserve what matters, verbatim | `restore.js` re-injects user messages word for word; the summary is demoted to "secondary interpretation" |
| LLM-OS: memory lives on disk, not in RAM | `store.js` — `prompts.jsonl`, `turns.jsonl`, `goal.json` under `~/.claude/bandaid/sessions/<id>/`. The goal survives compaction because it was never in the context window to begin with |
| "Ask for success" | `continuationPrompt`'s completion audit is that instruction made maximally explicit |
| Gen-verify loop with a real verifier | `verify.js` tier 1: a shell `check`, exit 0 or nothing. `assess()` puts it above every model opinion including the judge's (`verify.js:171-177`) |
| Bounded retries | `maxContinuations`, `stop_hook_active`, trivial-turn skip, token budget — four independent bounds in `decideOnStop` |
| Agents "cannot remember" | The ledger is exactly the compounding external memory that diagnosis calls for |

The `check` tier deserves specific credit. "Exit 0 is the only thing that closes a
goal without the model's say-so" is Karpathy's verifier, implemented literally,
with the correct failure policy: a check that cannot run has proven nothing, so it
fails closed.

---

## 3. Where it diverges: the prose/verifier inversion

Bandaid's prompt surface, measured:

| Prompt | Words |
|---|---|
| `continuationPrompt` | 678 |
| — of which the completion audit alone | 277 |
| `COMPACTION_FIDELITY_ADDENDUM` | 185 |
| `judgePrompt` | 151 |
| `budgetLimitPrompt` | 108 |
| `SUMMARIZATION_PROMPT` (Codex, verbatim) | 67 |
| **Total** | **~1,038** |

Roughly a thousand words of instruction are injected to make the model diligent.
**Nothing measures whether any of it works.** `npm test` is 87 green tests; the
only assertions that touch prompt text are three regex spot-checks in
`test/verify.test.js:153-176` (`/Continuation: 1 of 2/` and the presence of a
verification section). There is no full-text snapshot, so a prompt edit that
silently guts the audit breaks no test. There is no behavioural eval, so nobody
knows whether removing the 277-word audit would change a single outcome.

This is precisely the trade Karpathy says not to make: lengthen the prompt before
cheapening verification. And Bandaid is not short of places where prose is
standing in for a mechanism that already half-exists.

### The honor-system ledger

Sort every anti-laziness measure by who enforces it.

**Enforced by the runtime — the model cannot argue with these:**

- `stop_hook_active` → allow (`goals.js:191`)
- continuation cap (`goals.js:196-201`), token budget (`goals.js:203-205`)
- trailing `?` → allow, so the model can always ask (`goals.js:207-209`)
- trivial-turn skip (`goals.js:211-213`), chatter filter (`goals.js:103-132`)
- `check` exit status, an unconditional veto (`verify.js:171-177`)
- judge verdict from a process that never reads the transcript (`verify.js:179-195`)
- plateau counter, runtime-counted (`goals.js:88-97`)

**Enforced by asking nicely:**

- The entire 277-word completion audit — "derive concrete requirements", "treat
  uncertain evidence as not achieved", "the audit must prove completion, not
  merely fail to find obvious remaining work" (`prompts.js:151-162`).
- "Do not substitute a narrower, safer, smaller, merely compatible, or
  easier-to-test solution" (`prompts.js:148`).
- "Never mark a goal complete merely because the budget is nearly exhausted"
  (`prompts.js:174`).
- **"the same blocker has now repeated across turns"** (`prompts.js:173`) — the
  model is asked to count. Meanwhile `blockedStreak` and `lastBlocker` sit in the
  goal shape (`goals.js:57-58`) and `blockedThreshold: 3` sits in config, and
  **nothing reads or increments any of them.** This is the exact flaw
  `best-goal-report.md` line 78 convicts Codex of — a hysteresis rule counted by
  the model rather than the runtime — reproduced here with the counter already
  built and left unwired.
- All seven bullets of `COMPACTION_FIDELITY_ADDENDUM`, which depend entirely on
  the summarizer complying, and whose compliance is never checked.

The plateau counter shows the pattern is already understood: it took an
honor-system rule and moved it into the runtime. Three more rules are waiting for
the same treatment, and one of them has its fields sitting there unread.

### The requirements get re-derived every turn

`prompts.js:153` — "Derive concrete requirements from the objective" — runs afresh
on every single continuation. Nothing persists the result. So:

- The bar is re-interpreted each turn from prose, which is where scope shrinks.
  The prompt tries to compensate three separate times ("do not redefine success
  around a smaller or easier task", "preserve the original scope", "do not
  substitute a narrower… solution") — three paragraphs paying for one missing
  field.
- The judge (`verify.js:88-105`) derives its *own* reading of the objective,
  independently. Worker and judge are graded on two different rubrics that are
  only accidentally the same.
- Judge verdicts are therefore not comparable across turns, which means the
  plateau detector is comparing reasons that came from a moving rubric.

Karpathy's #4 is the fix and it is a data-structure change, not a prompt change:
derive the success criteria **once**, write them to disk, re-inject them verbatim.
"Give it success criteria and watch it go" only works if the criteria hold still.

### Restoration selects by recency, not relevance

`selectWithinBudget` (`restore.js:30-60`) walks newest-first and takes whole items
while they fit. Faithful to Codex, and wrong by Karpathy's definition: this is
"the most recent information", not "the right information for the next step".

Two concrete losses, both at exactly the moment the model is most vulnerable:

- A binding correction from early in the session ("never touch the vendored
  files") is evicted while recent chatter is kept. The block's own header claims
  "Standing constraints, preferences, and corrections in here remain in force" —
  a promise the selection function does not keep.
- `digest.js` already tags failed tool calls `[FAILED]`. Records of what was tried
  and failed are the single best guard against re-running dead ends and against
  confabulating a result — and they are dropped on the same pure-recency rule.
  `COMPACTION_FIDELITY_ADDENDUM` explicitly asks the *summarizer* to keep failures
  ("This is as valuable as what succeeded") while the restore path, which has the
  ground-truth records, discards them by age.

### Autonomy is fixed, not earned

`maxContinuations` defaults to 2 whether the goal has a shell check, a judge, or
nothing at all. Karpathy: "slide autonomy up as the verifier proves out." A flat
cap is simultaneously too generous for an unverified goal (two rounds of
self-graded work) and far too tight for a verified one — a goal with a passing
check can be closed mechanically and should be allowed to run much longer, because
the thing deciding when it stops is an exit code, not the model's opinion.

---

## 4. The four changes

Each discharges one claim from §1. None of them adds prompt text.

| # | Change | Discharges | Mechanism |
|---|---|---|---|
| 1 | **Eval harness** — `eval/` with judge fixtures, plus prompt snapshots in `npm test` | 1.4 "make verification cheaper before lengthening prompts" | Judge precision/recall on adversarial fixtures; golden-file diffs so prompt edits stop being invisible |
| 2 | **Persisted success criteria** — `goal.criteria[]`, derived once, injected verbatim to both worker and judge | 1.4 / #4 "give it success criteria" | A fixed rubric; deletes the need for three anti-shrink paragraphs |
| 3 | **Autonomy slider** — `maxContinuations` resolved from verifier strength | 1.4 "slide autonomy up as the verifier proves out" | check → 8, judge → 4, neither → 2 |
| 4 | **Relevance-pinned restoration** — pin corrections, `[FAILED]` digests, the goal's originating prompt | 1.1 "the right information for the next step" | Pinning pass ahead of the recency walk |

Change 1 is the one that makes the other three falsifiable. Without it, every
future prompt edit is a guess, which is how a 678-word continuation prompt gets
built in the first place: each addition is individually plausible and none is ever
measured, so nothing is ever removed.

The adversarial fixtures matter more than the count of them. Judge precision is
the whole product, and the failure mode worth catching is the flattering one:
a symbol that exists, a test file that exists with stubbed assertions, three of
four requirements met. A judge that says `complete` on those is worse than no
judge, because it launders a model's self-assessment as an independent one.

---

## 5. What not to do

**Do not add prompt prose without an eval.** This is the anti-pattern the report
exists to name. Every paragraph in `continuationPrompt` was added because someone
reasoned it would help. Some of them probably do. Nobody can say which, and the
cost is paid on every single continuation.

**Record the compensator status.** By the Bitter-Lesson test — *if the model were
2× better tomorrow, would this help more or get in the way?* — the completion
audit is a compensator for a current-model weakness, not an environment fact. The
`check` tier is not: a shell command's exit status is ground truth no model
improvement makes redundant. So the audit earns a **dated sunset note** and the
verifier does not, and the standing rule for anything added later is: *prefer a
check over a paragraph.* When a stronger model arrives, §3's honor-system list is
what should be deleted first, and the eval harness is what will say whether
deleting it cost anything.

**Do not wire `blockedStreak` from this session.** It is a real gap, named here for
the record, but `goals.js` and `stop.js` belong to the concurrent work implementing
`best-goal-report.md`.

---

## 6. Verdict

| Failure mode | Codex | Claude Code `/goal` | Bandaid today | Bandaid + §4 |
|---|---|---|---|---|
| Model grades its own work | ✗ | partial (separate judge, transcript-only) | ✓ check + judge | ✓ |
| Success criteria drift between turns | ✗ | ✗ | ✗ re-derived each turn | ✓ persisted rubric |
| Worker and judge use different rubrics | n/a | ✗ | ✗ | ✓ shared criteria |
| Autonomy unrelated to verification strength | ✗ unbounded | ✗ | ✗ flat 2 | ✓ slider |
| Binding constraints lost to compaction | ✓ verbatim by recency | ✗ | ✓ verbatim by recency | ✓ verbatim, relevance-pinned |
| Known dead ends re-run after compaction | ✗ | ✗ | partial (digests, evicted by age) | ✓ failures pinned |
| Loop stops converging | ✗ honor system | ✗ | ✓ plateau counter | ✓ |
| Blocked-streak hysteresis | ✗ honor system | n/a | ✗ fields exist, unread | unchanged (out of scope) |
| Anyone can tell whether the prompts work | ✗ | ✗ | ✗ | ✓ eval harness |

**In one line:** `best-goal-report.md` fixed *who grades the work*; this one fixes
*that nobody grades the grader* — and observes that Bandaid's thousand words of
diligence instructions are an unmeasured bet, where Karpathy's method says the
same effort spent on a verifier would be a measured one.

---

## Sources

- [Karpathy on context engineering](https://x.com/karpathy/status/1937902205765607626) — @karpathy, 25 Jun 2025
- [State of GPT](https://www.kaitakami.dev/blog/andrej-karpathy-state-of-gpt) — Microsoft Build, May 2023
- [The gen-verify loop and the autonomy slider](https://www.aibuilderclub.com/blog/loop-engineering-karpathy)
- [Four principles for better LLM coding](https://aiengineering.beehiiv.com/p/andrej-karpathy-s-four-principles-for-better-llm-coding)
- [Keep AI on the leash](https://www.techtimes.com/articles/310925/20250620/openais-andrej-karpathy-warns-against-unleashing-unsupervised-agents-too-soon-keep-ai-leash.htm)
- [Hallucination as the default mode](https://the-decoder.com/here-is-an-interesting-take-on-llm-hallucinations-by-andrej-karpathy/)
- [On memory, context, and why agents don't work yet](https://thegenios.com/blog/karpathy-on-memory-and-context/) — incl. Dwarkesh interview, Oct 2025
