# Bandaid

Replaces Claude Code's compaction and goal handling with Codex's, then fixes the
part Codex gets wrong.

Claude Code compacts by replacing the conversation with a summary. Everything you
typed becomes a paraphrase of what you typed, and every tool call becomes a
sentence about a tool call. Codex does it differently: it keeps user messages
**verbatim**, summarizes each turn **together with that turn's own tool calls and
results**, and spends a fixed token budget doing it.

Bandaid ports that behaviour onto Claude Code through its hook system.

```
Claude Code compaction              Bandaid compaction
──────────────────────              ──────────────────
[ summary of everything ]           [ Codex handoff summary        ]
                                    [ every user message, verbatim ]
                                    [ per-turn tool digests        ]
```

The concrete failure this fixes: you say *"migrate auth off JWT — do NOT touch the
billing module, it ships Friday"*, the session compacts an hour later, and the
constraint is now a clause in a paragraph the model skims. With Bandaid the
sentence is still there, in your words, marked as still binding.

---

## Install

```bash
claude plugin marketplace add SSHdotCodes/bandaid
claude plugin install bandaid@bandaid
```

Restart Claude Code. That is the whole setup — it starts working on the next
prompt. Verify with `/bandaid:status`.

<details>
<summary>Without the plugin system</summary>

```bash
git clone https://github.com/SSHdotCodes/bandaid.git
cd bandaid
node bin/bandaid.js install            # --scope project|local also available
```

This writes the six hooks into `~/.claude/settings.json`, backing up the existing
file first. `node bin/bandaid.js uninstall` removes exactly what it added.
</details>

Requires Node 18+ and Claude Code 2.1.220 or newer (older builds lack the
`PostToolBatch` and `PostCompact` events). No dependencies.

---

## What it actually does

Six hooks. Nothing is injected into your context until a compaction needs it, so
the steady-state cost is zero tokens.

| Hook | What Bandaid does |
|---|---|
| `UserPromptSubmit` | Writes your prompt verbatim to a session ledger on disk. Silent. |
| `PostToolBatch` | Records each tool call's name, the arguments that mattered, and what came back. |
| `PreCompact` | Replaces Claude's summarization directive with Codex's `CONTEXT CHECKPOINT COMPACTION` prompt, plus rules that force tool params, results, and exact identifiers into the summary. |
| `SessionStart` (`source=compact`) | Re-injects your messages verbatim and the turn digests, ahead of Claude's summary, marked as the authoritative source. |
| `PostCompact` | Prints a receipt of what was preserved; archives the summary. |
| `Stop` | The goal system: runs the check command and the judge, then blocks the stop with the completion audit if the objective is not proven done. See below. |

### Compaction

Claude Code has no way to replace its compaction outright, but `PreCompact` can
rewrite the instructions the summarizer follows, and `SessionStart` fires
immediately afterwards with its stdout going to the model. Bandaid uses both, so
the post-compaction context ends up in Codex's shape.

Message selection is a direct port of Codex's `build_compacted_history_with_limit`:
walk newest-first, keep whole messages while they fit a **20,000-token** budget
(Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`), middle-truncate the one that
straddles the boundary, drop the rest. Token estimation and truncation are ported
from `codex-rs/utils/string/src/truncate.rs` — `ceil(bytes / 4)`, truncating the
middle so both the head and the tail of a message survive.

Anything that falls outside the budget is reported, not silently dropped.
`/bandaid:preview` shows exactly what would be restored if you compacted right now.

**One departure from Codex: recency is not the only thing that buys a slot.**
Context engineering is filling the window with the right information for the next
step, and pure newest-first is a proxy for that which fails in two specific
places. A constraint you gave early — *"never touch anything under vendor/"* —
ages out while recent chatter stays, even though this block promises standing
constraints remain in force. And the record of what was already tried and failed,
the best guard there is against re-running a dead end, ages out on the same rule.

So before the recency walk, Bandaid pins the prompt the goal was made from,
messages that read as corrections or constraints, and turns containing a failed
tool call. Pinned items claim at most **half** the budget, so relevance can never
starve recency, and truncation still happens exactly once where Codex put it.
Message numbering is by real position, so a gap between `n="2"` and `n="9"` tells
the model that older messages were dropped, right where they were dropped.

### Goals

Claude Code ends a turn whenever the model decides it is finished, so a
half-finished task and a finished one look identical. Codex keeps a thread goal
alive across turns and re-injects a continuation prompt whose completion audit
treats "done" as an unproven claim until it is checked against the current state
of the files.

Bandaid reproduces that on the `Stop` hook, which can exit 2 to hand feedback back
to the model and keep the turn going. The continuation prompt is adapted from
Codex's `goals/continuation.md`, including the parts that matter most:

> Do not substitute a narrower, safer, smaller, merely compatible, or easier-to-test
> solution because it is more likely to pass current tests.

> Treat uncertain or indirect evidence as not achieved; gather stronger evidence or
> continue the work.

When the audit passes, the model closes the goal itself by running
`bandaid goal complete`, and Bandaid stops asking.

**It is bounded in six independent ways**, because a stop hook that can loop is
worse than no stop hook:

- `stop_hook_active` is honoured — Claude Code's own loop guard always wins.
- A goal may block at most `maxContinuations` times, then gives up.
- Turns that changed nothing (no `Edit`/`Write`/`Bash`/`Task`) are never audited.
- If Claude ended its turn asking *you* a question, the stop is allowed — always by
  default, and unless it was asking permission to do work already in scope when
  `goals.autonomy` is on (see below).
- Two identical verification failures in a row end the loop early (see below).
- Work this environment cannot do stops being asked for (see below).
- A wall-clock budget, if you set one, wraps the goal up (see below).

Set `goals.mode` to `"explicit"` if you only want `/bandaid:goal` to arm it, or
`"off"` to disable it entirely.

**The leash is earned, not fixed.** A flat number is still wrong in both directions
on a large task: a goal making verified progress hits its cap mid-refactor, while a
goal spinning on the same failure burns the whole cap doing it. So a round that
moved the work is **refunded** — it costs nothing — and a round that moved nothing
twice running costs **two**.

That means the worst case is no longer "two extra rounds". It is `3 ×` the tier
value in total rounds, spent plus refunded, and it is bounded on four other sides as
well: the wall-clock budget, the token budget, the blocker limit, and
`stop_hook_active`. A goal going nowhere now ends *sooner* than it did before any of
this existed, because a stall costs double — which is what makes the mechanism safe
to have on by default.

**What counts as progress is the whole difficulty**, because a refund is a reward
and any reward the model can pay itself gets paid. Ordered by how hard they are to
fake:

| signal | can the model fake it? |
|---|---|
| a criterion reached `covered` | no — that needs a check, probe, judge or expectation record, and `evidence.append` forces anything the model says to `unverified` |
| the verification failure changed in substance | no — "3 tests failing" becoming "1 test failing" is a different state |
| a task was completed | yes, it writes its own task list — so this buys **one** round per goal and no more |

Deliberately absent: the worktree fingerprint. It moves on any tracked edit, which
makes it exactly the signal not to reward. Editing a file is not progress.

**The cap tracks how strong the verifier is.** Karpathy's rule for agents is to
slide autonomy up as the verifier proves out, so a flat number is wrong in both
directions at once: two rounds is generous for a goal nothing can check, and
miserly for one that a shell command closes the moment it exits 0.

| what is watching the work | continuations |
|---|---|
| a `check` command | 8 |
| the judge, no check | 4 |
| neither | 2 |

`bandaid status` prints which tier you are in. A plain number in config still
overrides all three.

### The clock, and the third budget

Bandaid could tell the model how many continuations it had left and roughly how
many tokens it had spent. It could not tell it what time it was. Every record on
disk carried a timestamp and nothing ever subtracted two of them, so a model four
hours into an objective and one four minutes in read exactly the same prompt.

The continuation prompt now carries a clock:

```
Elapsed:
- Now: 16:42 (Thu 30 Jul)
- This goal: 3h 18m of 6h
- Since last progress: 11m
```

…and one line about what is actually scarce, in place of the four-line `Budget:`
block that used to say `none` and `unbounded` on every default configuration:

```
Capacity: continuation 2/4 · 3h 18m of 6h · ~50m left (5 tasks, 45m–1h)
```

Anything unbounded is absent rather than rendered, which is how this added a
wall-clock budget and an ETA and still took **15 words off every one of the ten
continuation prompts — 150 in total**, with every ceiling in
`test/prompts.snapshot.test.js` coming down rather than up.

The four quantities are not of equal quality and the line says so. Elapsed is
measured, continuations are counted, and anything with a `~` is not: `tokensUsed`
is a floor (it sums digests already truncated to 900 tokens each), and the ETA is
an estimate shown with the spread it came from.

And wall-clock joins turns and tokens as a budget you can set:

```bash
bandaid goal set --time-budget 2h -- "Reconcile the two billing ledgers"
```

which wraps the goal up through the same path a spent token budget uses — one
final turn to report, then the stop goes through. `90m`, `2h`, `1h30m` and plain
milliseconds all parse; anything else is **rejected rather than guessed**, because
a budget read wrongly caps the work at a number nobody chose and does it quietly.

This is the third of the three budgets `best-goal-report.md` specified. Turns and
tokens shipped; wall-clock did not, which left Bandaid one step behind the thing
that report criticises Codex for — tracking elapsed time and never enforcing it.
Bandaid was not even tracking it.

**Two deliberate limits.** The clock renders only where Bandaid already spends
tokens — a continuation, a compaction restore, and a `SessionStart` that had
something to say anyway. A session with no goal and no compaction still injects
nothing at all, because the zero-steady-state property is worth more than a clock
on a turn where nothing is deciding anything. And elapsed time gates a *budget*,
never *validity*: whether recorded evidence still describes the worktree stays
content-hashed, for the reason `src/lib/stamp.js` gives — a TTL is wrong in both
directions at once, and a fingerprint is exact.

### Asking permission was an unconditional escape hatch

Of the six ways the goal loop bounded itself, one was a line of punctuation
counting: if the last non-blank line ended in `?`, the stop went through. So a turn
ending *"Should I proceed?"* bypassed the completion audit, the fixed criteria, and
every verifier tier.

The reason that check exists is a good one — blocking a genuine question traps you
in a loop where the question is never actually asked — so it is not removed, it is
made to discriminate:

```jsonc
"goals": { "autonomy": true }   // off by default
```

With it on, a request for permission to do work already in scope no longer buys a
stop, and gets one 57-word paragraph telling it to decide and say what it assumed.
A genuine question — a credential, a choice it cannot rank, a value it cannot
derive — still ends the turn, and so does anything the classifier does not
recognise.

**The two errors are not symmetric, and the threshold comes from that, not from
accuracy.** Blocking a genuine question locks you out of a conversation you are
needed in until the budget runs out. Allowing a permission-ask costs one early turn
and a typed "continue" — it is the current behaviour. So the gate is that no
genuine question is ever blocked, and uncertainty always resolves to the old
behaviour, the same fail-open posture the judge takes when its verdict cannot be
parsed.

```
$ npm run autonomy
  corpus     26 cases (16 permission, 10 genuine)
  GATE       genuine questions still allowed 10/10 (100%)
  recall     permission-asks caught 15/16 (94%)  — not the gate
  unknown    3 case(s) matched nothing and fell through to allow
```

The one miss is *"Should I do the tests first or the docs first?"* — choice phrasing
around work that is entirely in scope. It costs a turn, which is the acceptable
direction. The corpus's two hardest rows are the mirror pair: an offer that contains
a real question (*"Would you like me to use the staging key, or do you have a
production one?"* — genuine) and a choice that contains none (the miss above).

It is off by default because it changes when Bandaid refuses to let a turn end, and
every existing user would get that on upgrade.

### Acceptance criteria

An objective is prose, and "what would count as done" gets re-read out of that
prose on every continuation — which is where scope quietly shrinks, and why the
judge and the model can end up grading against two different bars.

So the bar is fixed once and stored with the goal:

```
/bandaid:goal Port the retry logic to the new client
```

records the objective and then, in the same turn, 2–5 checkable criteria:

```
$ bandaid goal show
criteria:      3 (model)
  1. src/client.js retries a failing call with exponential backoff
  2. src/client.js no longer references retryLegacy
  3. test/client.test.js asserts that successive retry delays increase
```

From then on they are re-injected verbatim on every continuation, handed to the
judge as its rubric, and carried through compaction alongside the objective. The
completion audit grades them one at a time instead of re-deriving requirements.
They cannot be quietly rewritten later — `bandaid goal criteria` refuses to move
a bar that is already fixed unless you pass `--replace`.

### Across days: an objective that outlives its session

Everything above is scoped to one session. Close the terminal on a three-day
refactor and the objective, its fixed criteria, its constraints and its blockers
were all still on disk — under a session id nothing would ever look up again.

So a goal now has a second home, keyed by the **project** rather than the
conversation:

```
~/.claude/bandaid/projects/<sha256(git toplevel)>/handoff.json
```

It is a projection, not the source of truth. The live goal stays in the session
directory and the hot path is unchanged; the project record is written whenever
the goal moves and read only at session start and by the CLI. Git decides what a
project is, so `claude` from `src/` is the same project as `claude` from the
repository root — the old per-cwd hash said otherwise.

**A new session is offered the objective, not given it.** The default,
`goals.carryOver: "offer"`, names the objective, its age, and its bar, states
plainly that nothing is armed, and gives the one command that takes it up
alongside the one that drops it:

```
bandaid goal adopt      # take up this project's open objective
bandaid goal history    # what it is, how old, which sessions have worked it
bandaid goal clear --project
```

Adopting carries the bar across unchanged — criteria, constraints, blockers and
the commit the work started from — and the budget across fresh: a new day earns
a new continuation allowance, re-resolved against today's verifier.

`"auto"` adopts without asking, which is the unattended overnight mode and will
occasionally pick up an unrelated task from the same repository. `"off"` is the
behaviour before any of this existed.

A `--resume` or `--fork` needs none of it: the goal now travels with the ledger,
as it always should have. And `/clear` drops the session's copy while leaving
the project record — clearing your scrollback is not the same as abandoning
three days of work.

### The evidence ledger

The judge is handed a rendered digest of the current session's tool calls. On day
three of a goal that is nothing at all from days one and two — so it grades from
the repository alone, which is *safe* but not *informed*: it cannot know that
yesterday's approach was tried and abandoned, or that criterion 3 was proven at
4pm by a check that has since gone red.

So verdicts accumulate in `projects/<key>/evidence.jsonl` as **claims with
pointers**. A tool digest says what happened; an evidence record says what is
claimed to be true and where to go and check.

```
criterion 1  measured  supported  check `npm test` exited 0        [2026-07-26 14:31]
                                  cmd:npm test
criterion 2  engineer  unverified the migration is idempotent      [2026-07-26 14:02]
                                  src/migrate.js:88
```

**The asymmetry is the point.** The runtime writes what it measured from an exit
status. The model may only ever append an `unverified` claim — `bandaid evidence
add` forces the kind and the verdict no matter what it asks for. A claim is a
lead for the judge to follow, never a finding.

Each record carries a fingerprint of the worktree it was taken against, so a
proof from Monday is shown to Thursday's judge as history rather than as current
truth. Failures are kept for exactly the reason they are worth keeping: the
record of what has already been tried is the best guard there is against
re-running a dead end.

That arithmetic also produces one line in the continuation prompt, in place of
several paragraphs asking the model to grade its own criteria:

```
Evidence by criterion: 1 measured · 2 asserted but not measured · 3 no evidence.
```

Where the criteria section states the bar, that line reports the score — and a
criterion nothing measured is not a criterion that passed.

### Probes: verification that takes longer than a hook

A `check` is one shell command, boolean, synchronous, and unable to say "not
applicable here". That is enough for `npm test` and not enough for the things
that decide whether multi-day work landed — a browser at four viewport widths, a
minute of sustained load, a scanner that wants a lockfile this project does not
have.

**One rule shapes the whole feature: probes veto, they never prove.** A browser
probe passing does not prove *migrate auth off JWT*; it proves the page renders.
So a probe can block a stop and feed the judge, and only `check` and `judge` can
close a goal. Three things fall out of that: a misconfigured probe can never
close a goal early, which is the expensive error; composition needs no weights,
because any-veto is the rule `check` already uses; and there is no new autonomy
tier, because a probe makes the loop safer rather than longer.

A project declares its own, in a committed file:

```json
// .bandaid/probes.json
{ "probes": [
  { "id": "browser", "run": "node .bandaid/probes/browser.js",
    "when": { "changed": ["src/**/*.tsx", "src/**/*.css"] },
    "timeoutMs": 60000, "summons": "bandaid-browser-verify" }
] }
```

**Exit status is the verdict, and stdout is never read as one:**

| exit | meaning |
|---|---|
| `0` | pass |
| `78` | **abstain** — no tooling, not applicable, nothing to say. Invisible: identical to the probe not existing. |
| anything else, a timeout, or a signal | fail — vetoes the stop |

The probe owns its own abstain decision; Bandaid never guesses it. A well-formed
probe opens with `command -v k6 >/dev/null || exit 78`. Silence from a probe that
*started* is still not evidence, so it fails. `78` rather than `2` because
`grep` returns 2 on error and plenty of CLIs use it for a usage mistake — a
probe must not decline by accident.

If the last line of stdout is JSON it becomes detail — a summary for the
continuation prompt, artifact paths for the ledger — but it can never change the
verdict. A probe printing `{"ok":true}` and exiting 1 has failed.

**A committed manifest is arbitrary shell execution**, so nothing in it runs
until its exact contents are approved:

```
$ bandaid probes trust
```

Change one byte and it goes back to asking. A world-writable manifest, or one
owned by another user, is refused whatever its approval state.

**Probes run out of band.** The Stop hook launches them detached and reads a
cached verdict keyed by a fingerprint of the worktree — HEAD, `git status
--porcelain -uall`, and the size and mtime of everything dirty or untracked. A
time-to-live would be wrong in both directions at once; a content fingerprint is
exact. The continuation loop is already the scheduler, so a ninety-second probe
only has to survive one continuation.

A probe still measuring cannot veto — every first stop after an edit would
otherwise block — but it can **hold a close** once, so its answer is not thrown
away by a goal closing a second early.

### The four probes that ship with it

Bandaid installs **no tooling** and takes **no dependencies**. Each of these is a
skill that tells the model how to produce evidence, plus a grader that turns
that evidence into an exit status.

| probe | what it measures | abstains when |
|---|---|---|
| `browser` | a real browser at 375/768/1440: console errors, failed requests, horizontal overflow, the journey completing, and 2–5 assertions you wrote for the change | no report, or one from an earlier worktree |
| `load` | sustained concurrency against a budget written beforehand: p95, p99, error rate, rps | no budgets file, or the service is not running |
| `secrets` | credentials **this work introduced**, in the diff and in new untracked files | there is no git to diff against |
| `sweep` | the same class of defect elsewhere, where every finding ships a command that fails now | nobody has swept, or there is no seed |

Three are built in and need nothing installed:

```json
{ "probes": [
  { "id": "secrets", "builtin": "secrets", "when": { "changed": ["**"] } },
  { "id": "load",    "builtin": "load",    "when": { "changed": ["src/api/**"] } }
] }
```

**The browser probe is the interesting one**, because "verify it at real viewport
sizes like a user would" is not one assertion — it is four, and only the last
needs judgement:

1. the journey completes at every width;
2. zero console errors and zero failed requests;
3. `scrollWidth <= innerWidth` at every width;
4. nothing visually broken that 1–3 miss.

The first three fail loudly, cheaply, and without a model. The fourth is why
screenshots are still taken, and it is graded against a rubric that ends with
*"if you would say it would look better, that is not a finding"* — because the
failure mode of a model grading a screenshot is an unbounded list of taste
notes, and a probe that returns one never passes.

The skill picks a driver in order — the project's own Playwright or Puppeteer,
then `npx playwright` **only if browsers are already installed**, then a browser
MCP server, then nothing. It never runs `playwright install`: downloading 300 MB
inside a verification is a side effect nobody asked for.

There is one gate worth naming on its own: **every screenshot must exist and
exceed 1 KB.** The cheapest way to pass a browser probe is to write a clean
report without opening a browser, and a real PNG per viewport is a crude, cheap
barrier to exactly that.

**Sweep** is the one that turns "are there bugs" into an exit code. There isn't
one, so it does not invent one — instead every finding must ship a command
expected to fail *right now*, and the runtime runs it:

```
reproExit !== 0  →  confirmed bug
reproExit === 0  →  discarded as unreproducible
```

The agents propose and only the runtime touches a shell, which is what keeps a
fan-out of read-only searchers safe to trust. A finding cannot mark itself
confirmed, the same asymmetry that stops the model writing `supported` into the
evidence ledger. Dismissing one takes a reason, in a reviewable file.

### Expectations: predictions, not memories

```
bandaid goal expect --says "0" -- "grep -c retryLegacy src/client.js"
```

The model records these *as it works*, and the runtime runs all of them at every
stop. The value is entirely in the timing: an assertion recorded at the moment of
an edit is a **prediction**, while the same claim at the end of the turn is a
**memory** — and memory is exactly what this system distrusts. A model that
predicts `0`, then measures `3`, has caught itself with no second model in the
loop and no tokens spent.

It is the cheapest verifier here, and the only one that needs nothing installed.

### Scope: the constraint as a set

```
bandaid goal scope "src/sync/**" "test/**"
```

`extractConstraints` is a regex over the objective's prose that both over- and
under-matches. Declared paths turn *"do NOT touch the billing module"* into
`baseSha..HEAD` minus a glob list — set membership, not a paragraph asking the
model to remember. Out-of-scope changes block the stop and are named.

### Self-check: the completion audit, computed

`src/lib/prompts.js` spends 277 words asking the model to grade each criterion
honestly and to treat *absence of contradiction* as *absence of proof*. It is
the largest compensator in the codebase, and by the Bitter-Lesson test it is the
first thing that should stop being necessary.

`bandaid self-check` is the mechanical version — arithmetic over a ledger the
model can only append **unverified** claims to, so the answer is not up for
negotiation:

```
coverage: 2 of 4 criteria have measured, current evidence.

  1. src/client.js retries with exponential backoff
     covered — check `npm test` exited 0
  2. src/client.js no longer references retryLegacy
     claimed-only — you asserted this; nothing measured it.
     Add a check, a probe, or an expectation that fails if it stops being true.
  3. the checkout flow works at 375px
     refuted — probe `browser`: horizontal overflow at 375px
  4. the migration is idempotent
     uncovered — nothing has been recorded for this criterion at all.
```

A fifth state matters more than it looks: **contradicted**, when two verifiers
looking at the same worktree disagree — a green check beside a failing probe on
one criterion. That is precisely where another blind attempt is worthless.
Nothing is unfinished; two measurements cannot both be right; only finding out
which resolves it.

The audit paragraphs stay for now, with a dated sunset note. They are probably
load-bearing today, and `npm run eval -- --ablate completion-audit` is how that
stops being a guess rather than something to act on early.

### Blockers: the difference between "not yet" and "not from here"

A loop that only knows *unfinished* treats "the tests don't pass yet" and "proving
this needs a GPU that isn't in this machine" as the same state, and hands both back
for another attempt. The second one is unwinnable at the moment it starts, and it
stays unwinnable for every remaining turn in the budget.

That is not hypothetical. Across ~190 real Claude Code sessions from one project —
using the *native* `/goal`, not Bandaid — roughly a third of the goal-condition stop
blocks name a blocker no amount of model effort clears: hardware that is absent, a
service that isn't running, a browser interaction that can't be driven headlessly, a
data source that doesn't exist. (Roughly, because deciding what counts is a reading
of prose, not a crisp count.) They cluster at the **end** of the longest loops.

The one that is exact, because it is a single measurable session: a goal blocked
**seven times over 80 minutes**, across 651 assistant messages and **589,414 output
tokens**, whose last three blocks were restatements of "I can't do this headlessly."

So the model can record it, once:

```bash
bandaid goal block "confirming the fix needs a GPU this session cannot reach"
```

That does **not** close the goal — the rest of the objective is still worth working.
It does three things: the blocker is re-injected every turn marked *accepted, do not
re-argue*, it is handed to the judge as something not to count against completion,
and after `blockerLimit` of them (default 2) Bandaid stops continuing the goal and
lets you unblock it.

Recording a blocker is not an escape hatch from hard work. A failing check outranks
it — while a check command is red, that is unfinished work with a blocker attached,
not a blocked goal — and the continuation prompt says plainly that difficulty,
length, and a failing test are not blockers.

The old prompt had this exit, and gated it behind *"the same blocker has now
repeated across turns"*: the model was told to loop at least twice before it was
allowed to say it was stuck. That sentence is gone.

### Constraints: the half of the objective the audit wasn't grading

"Migrate auth off JWT — do NOT touch the billing module" carries two requirements
and only one of them is a thing to build. A completion audit grades what was built,
so the second one quietly stops being graded at all: every criterion can be
satisfied by work that also broke the one thing you said to leave alone, and the
audit reads that as success.

Bandaid pulls the negative clauses out of the objective when the goal is set, stores
them beside the criteria, and gives them to the judge as **vetoes** — with an
instruction to go looking for the state they forbid, since a deleted thing leaves no
trace of itself except the manifests and imports still pointing at it.

A broken constraint gets its own verdict, because it needs the opposite response
from an unmet criterion. Unmet means keep working. Broken means **stop**: the damage
is in the worktree already, another attempt cannot undo it, and a model choosing its
own remedy is how a bad delete becomes a bad delete plus an improvised restore. So
Bandaid closes the goal, blocks exactly once, and spends that turn making the model
tell you what it broke and what recovery would take.

The same corpus has this one too: a goal carrying "…without touching things that are
used", a directory deleted that the user had explicitly said not to touch, and the
judge correctly catching it — then blocking the stop **four times in thirty
seconds**, asking for another attempt at something no attempt could fix.

### Verification: the part Codex does not have

Codex's audit is good prompt engineering, and prompt engineering cannot fix its
one structural problem: **the model grading the work is the model that did the
work**. A model already convinced it is finished reads its own evidence
charitably, and the audit becomes a formality it passes. Claude Code's own
`/goal` has the opposite half of the answer — an independent judge — but that
judge only ever sees the transcript, so it cannot check a claim the transcript
does not contain, and it goes blind the moment a compaction summarizes the
transcript away.

Bandaid puts two things outside the model in front of the stop.

**A check command — ground truth.** Attach a shell command to the goal and exit 0
becomes the definition of done:

```bash
/bandaid:goal Migrate auth off JWT --check "npm test"
```

Exit 0 closes the goal automatically, whether or not the model got around to
saying it was finished. Anything else vetoes the stop and the real output is
handed back:

```
Verification result (external — not your own assessment, and not up for debate):
The command `npm test` was run against the current worktree and did not succeed.
<check-output>
FAIL src/auth.test.ts:41  expected 200, got 401
</check-output>
```

That is immune to everything prompts are not: self-assessment bias, drift over
long sessions, and compaction. A check that cannot run — typo, missing binary,
timeout — counts as *not proven*, never as proof.

**A judge — independence with hands.** Off by default; turn it on with
`"goals": {"judge": true}`. Before a goal closes, a separate headless Claude
(Haiku, read-only: `Read`, `Grep`, `Glob`) inspects **the repository**, not the
conversation, and answers `complete` or `continue` with one reason. Because it
reads the worktree rather than the transcript, compaction cannot blind it. It
runs with Bandaid disabled in its own environment, so a verification can never
recurse into another verification, and if it crashes, times out, or is not
installed it simply abstains — you get the old behaviour, not a wedged session.

Given a tool log claiming *"Redis store implemented with pooling, all
requirements satisfied"* for a file that does not exist, the judge answers:

> `continue` — src/lib/redis-store.js does not exist; the objective requires its
> implementation and it is not present in the repository.

Ground truth outranks the judge, which outranks the model. A failing check ends
the argument — the judge is not even consulted. A *passing* check still gets
judged when the judge is on, because green tests and a satisfied objective are
not the same claim.

**A plateau breaker.** Both budgets — Codex's tokens and Bandaid's continuation
count — measure how much has been spent, not whether anything is moving. When
two verification runs in a row produce the byte-identical failure, the loop has
stopped converging and Bandaid hands the problem back rather than spending the
rest of the budget on it. Changing failures ("3 tests failing" → "1 test
failing") are progress and reset the counter.

Run `/bandaid:verify` at any time to see the same verdict the Stop hook sees —
otherwise a failing check is visible only to the model, and "why does it keep
going?" has no answer.

#### Note on Claude Code's built-in `/goal`

Claude Code 2.1.220 ships its own `/goal <condition>`, which loops until a stated
condition is judged met. It is a different thing: opt-in per invocation, phrased
as a boolean condition, and unrelated to compaction. Bandaid's goals are a
persistent objective with Codex's evidence-based completion audit, applied
automatically. They coexist — both push in the same direction — and you can turn
Bandaid's off and use the native one if you prefer.

---

## Commands

| Command | |
|---|---|
| `/bandaid:status` | Config, install state, what has been captured |
| `/bandaid:preview` | Exactly what would be restored if you compacted now |
| `/bandaid:goal <objective> [--check "<cmd>"]` | Set an explicit objective, optionally with a command that proves it done. `--time-budget 2h` caps its wall-clock |
| `/bandaid:goal-status` | Show the objective, its check, and its continuation budget |
| `/bandaid:goal-done` | Close the objective |
| `/bandaid:verify` | Run the check and the judge now, and show the verdict |
| `/bandaid:probe` | What each probe last said about the current worktree |
| `/bandaid:self-check` | Which criteria have measured evidence, and which are only asserted |
| `/bandaid:goal-resume` | Take up the objective this project left open |

The `bandaid` CLI has the same surface plus `install`, `uninstall`, `doctor`,
`inspect`, `durations`, `tasks`, `sessions`, `sessions prune`, `prompt`, `goal criteria`, `goal block`,
`goal adopt`, `goal history`, `goal expect`, `goal scope`, `probes list|trust`,
`probe status|run|arm|disarm`, `self-check`, `evidence show|add`, and `on`/`off`.
`goal block <reason>` records one thing this environment cannot do and keeps the
goal running; `goal blocked` gives up on the whole objective.

---

## Configuration

`~/.claude/bandaid/config.json`, merged over the defaults:

```jsonc
{
  "enabled": true,
  "compact": {
    "userMessageMaxTokens": 20000,  // Codex's verbatim budget
    "digestBudgetTokens": 20000,    // budget for turn digests
    "turnDigestMaxTokens": 20000,   // ceiling for one turn
    "toolResultMaxTokens": 900,     // ceiling for one tool result
    "useCodexSummaryPrompt": true,
    "recordTurns": true
  },
  "goals": {
    "mode": "auto",                 // "auto" | "explicit" | "off"
    // scales with the verifier; a plain number overrides all three tiers
    "maxContinuations": { "verified": 8, "judged": 4, "unverified": 2 },
    "tokenBudget": null,
    "timeBudgetMs": null,           // wall-clock ceiling per goal
    "skipTrivialTurns": true,
    "autonomy": false,              // a permission-ask still ends the turn
    "check": null,                  // shell command; exit 0 closes any goal
    "judge": false,                 // independent read-only verifier
    "judgeModel": "haiku",
    "judgeCli": "claude",           // binary the judge runs as
    "verifyTimeoutMs": 120000,      // ceiling for one check or one judge run
    "plateauLimit": 2,              // identical failures before giving up
    "blockerLimit": 2               // recorded blockers before giving up
  },
  "retention": {
    "enabled": true,
    "sessionMaxAgeDays": 30,        // drop session dirs untouched this long
    "sessionMaxCount": 200,         // hard ceiling, newest kept
    "sweepIntervalHours": 24        // how often SessionStart may sweep
  }
}
```

A session whose goal is still `active` is **never** pruned, whatever its age.
That is the multi-day case, and deleting it is the failure the goal system
exists to prevent.

A check command is the cheapest large win here. With one attached, looping is
safe — the loop cannot end on a false positive — which is why attaching one
raises the continuation cap on its own.

Env overrides for one-off runs: `BANDAID_ENABLED`, `BANDAID_COMPACT`,
`BANDAID_GOALS`, `BANDAID_GOAL_MODE`, `BANDAID_MAX_CONTINUATIONS`,
`BANDAID_TIME_BUDGET`,
`BANDAID_USER_MESSAGE_MAX_TOKENS`, `BANDAID_DIGEST_BUDGET_TOKENS`,
`BANDAID_HOME`, `BANDAID_DEBUG`.

`bandaid off` is the kill switch; it disables every hook without uninstalling.

---

## Where your data goes

`~/.claude/bandaid/sessions/<session-id>/` — `prompts.jsonl` (verbatim),
`turns.jsonl` (tool digests), `goal.json`, `summaries.jsonl`, `meta.json`, plus
`~/.claude/bandaid/projects/<key>/handoff.json` for the objective a project left
open. All
local, never transmitted. Delete the directory at any time; Bandaid rebuilds what
it can from Claude Code's own transcript.

Because it can backfill from the transcript, installing mid-session still works —
the first compaction after install replays prompts from before Bandaid existed.

---

## Honest limits

- **Claude's summary is not removed.** Claude Code compacts internally and no hook
  can prevent that. Bandaid changes the instructions that produce the summary and
  restores the primary material alongside it. The summary is still there.
- **Restoration costs tokens.** Up to ~40k on a long session — that is the point
  (you are buying back context), but it is not free. `/bandaid:preview` shows the
  bill before you pay it.
- **Assistant reasoning is not preserved verbatim**, only your messages and the
  tool record. That matches Codex, which also summarizes the model's own turns.
- **Digests are lossy by design.** Tool results are capped (900 tokens each by
  default) and middle-truncated. A 50k-line log becomes its head and tail.
- **Without a check command, the goal system depends on the model cooperating**
  to run the completion command. When it does not, the continuation cap ends the
  loop and the turn stops normally. A check command removes that dependency
  entirely — it is the single most useful thing you can configure.
- **A check command is only as good as the command.** `npm test` proves the tests
  pass, not that the objective was met; that gap is what the judge is for, and
  the judge is a model too. Neither tier turns a vague objective into a
  verifiable one.
- **The plateau breaker fires, and until recently it fired far too eagerly.** This
  entry used to say it "almost never fires" — replayed against two real stuck loops
  it would have fired zero times, because a judge writes fresh prose each round and
  token overlap between consecutive reasons sat at 0.2–0.7 with no threshold
  separating "stuck" from "progressing". That replay is still the right result for
  *judge*-graded loops, and no similarity metric has been added for them.

  What it got wrong was the check-command case. The failure reason it compares
  contained only the **command**, not the output — a constant for a given goal — so
  it fired after any two consecutive failing check rounds regardless of progress.
  `npm run loop` demonstrates the damage: a goal landing one of four pipeline
  stages per round, reporting `only 1 of 4`, `only 2 of 4`, `only 3 of 4`, was
  **terminated at round 3 before it could go green at round 4.** The reason now
  carries the first line of the output, which is what the paragraph always claimed
  it compared. On the loop fixtures it ends 3 of 4 stuck loops and no converging
  ones.
- **The stall rule never ends a loop.** `npm run loop` reports it `DEAD`: the
  plateau breaker is checked first (`src/hooks/stop.js:242`, before
  `progress.settle` at `:262`) and reaches its limit a round earlier on every stuck
  fixture. The stall's double-cost still accelerates the budget; it simply never
  wins the race. Whether it reaches anything plateau cannot is **unverified** — that
  needs a judge-graded fixture, and the judge needs `claude` on `PATH`.
- **A check with nondeterministic output buys refunds it did not earn.** Because
  "the verdict changed" counts as progress, a suite that prints timings or
  randomises order looks like it is advancing. On the `stalling-varied` fixture that
  is 5 refunds across 6 rounds of pure churn. It stays bounded by the `3 ×` round
  ceiling and the wall-clock budget, but "the output changed" is a weaker proxy for
  progress than it reads as.
- **An expectation can never make a criterion `covered`, though `expect` is listed
  as a measured kind.** `bandaid goal expect` takes no `--criterion`, and
  `verify.assess` writes an `expect` record only when one *fails*
  (`verdict: 'refuted'`). So a passing expectation is invisible to
  `evidence.coverage`, and `bandaid self-check` can only ever reach `covered` via a
  check, a probe, or the judge. Six passing expectations and five criteria still
  read `0 of 5 measured`, which is confusing rather than wrong — the expectations
  are real and do block a stop when they stop holding. Closing the gap means adding
  `--criterion` and recording the passing path, which is a decision about ledger
  volume, not a typo.
- **The earned leash is not measured yet, only bounded.** The refund is asserted by
  unit and end-to-end tests — a changed check output refunds, an identical one costs
  double, the ceiling holds at `3 ×` the tier — but whether it *reduces
  rounds-to-completion* needs a harness that runs the loop rather than the grader,
  and that does not exist yet. Until it does, this is a mechanism with a safety
  argument and no efficacy number.
- **A goal with no verifier earns almost nothing.** Two of the three progress signals
  need a check, a probe, a judge or an expectation, so the refund helps `verified`
  and `judged` goals and barely touches `unverified` ones. That is the autonomy
  slider working as intended, and it means "work on larger tasks" is conditional on
  attaching a check command.
- **The permission-ask classifier is patterns, not comprehension.** It catches 15 of
  16 permission-asks in a 26-case corpus and blocks none of the 10 genuine
  questions. A permission-ask phrased in a way the corpus does not contain falls
  through to `allow`, which is the old behaviour; recall is reported and is not 100%.
  The corpus is this repository's own phrasing plus hand-written adversarial pairs —
  one model, one codebase.
- **A blocked permission-ask spends a continuation.** On a goal with two rounds left,
  two permission-asks exhaust the budget and the turn ends anyway.
- **The ETA is uncalibrated on real work, and says so.** `npm run eta` backtests it
  against recorded sessions; today it reports *nothing scoreable*, because a session
  needs a finished task list to have a horizon and only one local session had a task
  list at all. The numbers that exist come from a synthetic fixture and establish
  that the harness scores, not that the estimate is accurate. The backtest already
  earned its place twice: it caught a methodology bug that produced a MAPE of
  837,734%, and it deleted the estimator's trimmed median for measuring worse than
  a plain one.
- **Most sessions have no task list to count.** Bandaid asks the model to keep one
  and now reads it back — from `TaskCreate`/`TaskUpdate`, which carry stable ids, or
  from `TodoWrite`, which does not. Across 15 local sessions, **1 used a task tool
  at all**. So anything derived from task counts is absent far more often than it is
  present, and has to degrade to something else rather than to a guess.
- **A task list is the model's own account of its plan, not ground truth.** Nothing
  closes a goal because a task said `completed`; the criteria and the evidence
  ledger remain the only bar. A vanished task is recorded as **dropped, never as
  done** — inferring completion from absence would make every mid-work restructure
  look like a burst of productivity.
- **Matching a reworded `TodoWrite` entry is a guess.** A word-boundary prefix test
  catches the common case exactly; past that it is token overlap at 0.6, and
  durations resting on it are flagged `fuzzy` and excluded from any headline number.
  Two identically-worded tasks are told apart only by their position in the list.
- **A recorded tool duration is the duration of the *call*, not of the work.** An
  asynchronous tool that launches something and returns looks like 20ms. A tool
  that waits for you to answer measures how long you took. Both are true readings
  of what was asked and neither is what a reader assumes, so the profile reports
  per-tool percentiles rather than one number for "a tool call".
- **`hook` timing has never been observed.** No real `PostToolBatch` payload
  inspected carries a duration, so every sample comes from the transcript, where
  `tool_result.timestamp − tool_use.timestamp` is exact. The `gap` fallback — the
  interval between two batches completing, which contains the model's own thinking
  time — is implemented and tested but unused in practice, and its inflation on
  real work is unmeasured.
- **The clock is not always on.** It renders in the continuation prompt, in the
  compaction restore, and on a `SessionStart` that was already emitting something.
  A session with no goal and no compaction sees no time at all — that is the price
  of injecting nothing until something needs it, and it was chosen over a per-turn
  block costing roughly 35 tokens every turn forever.
- **"Since last progress" currently means "since last edit".** It advances on any
  turn that ran `Edit`/`Write`/`Bash`/`Task`, so a turn that changed files while
  achieving nothing counts as progress. A signal worth the name has to read the
  evidence ledger; until it does, that line is weaker than it sounds.
- **An adopted goal's clock restarts.** `startedAt` resets on adoption so a
  wall-clock budget matches the fresh continuation allowance a new day earns. The
  objective's true age is `createdAt`, which is what `bandaid goal history` shows —
  so a 2h budget means 2h per session, not 2h across three days.
- **Constraint extraction is a regex over the objective's clauses.** It finds
  `do not`, `never`, `avoid`, `must not`, `without touching`, and friends. Phrase
  a constraint some other way and it is not extracted, and nothing tells you so —
  `bandaid goal show` lists what was found, which is the only way to check.
- **The `violated` verdict is the least reliable tier.** Over 8 runs against the
  `constraint-violated` fixture with Haiku it landed 6 times; the misses were the
  judge asserting the constraint was intact without going to look. A missed
  violation degrades to ordinary "continue", so the cost is the old behaviour, not
  a wrong stop. A stronger `judgeModel` is the lever if this matters to you.
- **The judge costs a subprocess and 12–16s** (measured over three Haiku runs
  against `eval/fixtures/done`: 12.4s, 13.8s, 15.7s) on stops
  that would otherwise be blocked, and needs `claude` on `PATH`. It is off by
  default for that reason. If it cannot run it abstains silently rather than
  blocking.
- **Two sessions in one directory used to confuse the CLI.** Each session now
  drops its own pointer and any command that *writes* a goal refuses rather than
  guessing, listing both ids and asking for `--session`. Reads still resolve to
  whichever prompted last.
- **A fresh session is offered the project's objective, never given it.** That
  is deliberate — a session must not replay another conversation's instructions
  — but it means unattended multi-day work needs `goals.carryOver: "auto"`, and
  in that mode a second, unrelated task started in the same repository will pick
  up the first one's objective. `bandaid goal history` is how you find out, and
  `goal clear --project` is how you stop it.
- **The project key is the git toplevel.** Two worktrees of one repository are
  two projects, which is usually what you want and occasionally is not. Outside
  git it falls back to the directory, so moving a non-git project loses its
  record.
- **The shipped probes measure a delta, not a codebase.** `secrets` fails on
  what this work introduced and reports the rest; `sweep` needs a seed. That is
  deliberate — an absolute gate fails every real repository on day one and is
  switched off on day two — but it means neither is an audit.
- **A sweep reproduction runs in the working directory**, with a 60-second cap
  and Bandaid disarmed, not in a sandbox. One that reaches the network or
  installs something escapes that; the skill says not to write one and nothing
  enforces it.
- **The built-in load generator is not a good load generator.** Fixed
  concurrency, one machine, `fetch`. It catches a fall from 2000 rps to 40. It
  will not tell 1900 from 2000, and it measures a regression rather than a
  production ceiling.
- **A probe that abstains looks like verification and provides none.** Four
  armed probes that all exit 78 leave a goal nobody is watching. `bandaid probe
  status` and `bandaid verify` both say so; nothing stops you ignoring them.
- **`when.changed` is globs and nothing more.** No conditions, no expressions. A
  project that needs logic writes it in the probe script, where it is testable
  and where the probe can exit 78 for itself.
- **A detached probe can leak.** A crashed runner leaves a lock and no result,
  which reads as still-in-flight until the lock ages out. `bandaid probe status`
  shows it and `bandaid probe clear` removes it.
- **The ledger's staleness rule is coarse.** Any tracked edit moves the worktree
  fingerprint, so on a busy day most records show as history rather than as
  current proof. That errs in the safe direction — the judge re-reads the files
  anyway — but it costs tokens, and content-hashing only the changed set is the
  upgrade if it bites.
- **Nothing was ever deleted before now.** Retention is on by default and sweeps
  at most once a day from `SessionStart`; `bandaid sessions prune --dry-run`
  shows what it would take first.
- **Tested against Claude Code 2.1.220.** Hook input field names are product
  internals and could change; `bandaid doctor` and the end-to-end tests are how
  you find out.

---

## Development

```bash
npm test          # 364 tests, no dependencies, no network
npm run eval      # measures the judge against fixtures; needs `claude` on PATH
npm run eta       # backtests the ETA against recorded sessions; skips if none
npm run autonomy  # scores the permission-ask classifier against its corpus
npm run loop      # runs the Stop loop against 7 fixtures; offline, ~17s
node bin/bandaid.js doctor
```

`test/hooks.e2e.test.js` runs the real hook scripts the way Claude Code runs them
— JSON on stdin, meaning carried by the exit code — against a throwaway state
directory. It is the suite that catches an integration break.

`test/prompts.snapshot.test.js` holds every injected prompt as a golden file in
`eval/snapshots/`. Roughly a thousand words of instruction reach the model, and
without these a prompt edit broke no test and was invisible in review. Refresh
with `UPDATE_SNAPSHOTS=1 npm test` and read the diff.

It also records a **word-count ceiling per prompt**. A golden makes an edit
visible; it does nothing to make growth expensive. The ceiling does: exceeding
one fails the suite, so lengthening a prompt means raising a number somebody
reviews. They are not targets — every one of them should be going down.

### Measuring the grader

Bandaid's case rests on a verifier that outranks the model's own opinion, which
only helps if the verifier is right. `eval/fixtures/` is built around the failure
that matters — work that *looks* finished:

| fixture | expected |
|---|---|
| `done` | complete |
| `stubbed-test` | continue — the test exists, its assertion is vacuous |
| `not-implemented` | continue — the symbol exists, the body throws |
| `missing-test` | continue — two of three criteria met |
| `check-fails` | continue — code looks right, the check exits non-zero |
| `blocked-by-environment` | complete — one criterion needs absent hardware and is recorded as blocked |
| `constraint-violated` | violated — the cleanup is correct, but a protected directory was emptied |
| `flattering-claim` | continue — the ledger is full of confident engineer claims; every body throws |
| `stale-evidence` | continue — every criterion genuinely passed, against a worktree since reverted |
| `coverage-gap` | continue — two criteria measured, the third only asserted |

The last three exist because the evidence ledger gave the judge a new way to be
wrong: believing it. Each seeds a ledger that says the work is done over a
repository where it is not.

```
$ npm run eval
  accuracy   10/10 (100%)
  confusion  complete-when-complete 2   complete-when-not 0
             continue-when-not      8   continue-when-complete 0
  precision  100%  (of the goals it closed, how many were really done)
  recall     100%  (of the goals really done, how many it closed)
```

On `flattering-claim` the judge answered, unprompted: *"src/client.js contains
only unimplemented stubs; exponential backoff logic is missing, and
test/client.test.js does not exist."* Three confident claims with pointers, and
it went and looked at what they pointed at. That is the ledger working as
designed — a lead to follow, never a finding to accept.

### Ablation: does each block earn its tokens?

```
npm run eval -- --ablate ledger      # withhold the evidence block from the judge
npm run eval -- --ablate criteria    # withhold the fixed rubric
npm run eval -- --ablate constraints
npm run eval -- --ablate blockers
```

Each run withholds one block and reports the same matrix. **A mechanism whose
ablation moves no number is a mechanism to delete**, and saying so in advance is
what makes deleting it a result rather than a defeat.

**The first number this produced is a null result, and it is about the ledger:**

```
$ npm run eval                      accuracy 10/10   precision 100%
$ npm run eval -- --ablate ledger   accuracy 10/10   precision 100%
```

Withholding the evidence ledger from the judge changed nothing. On this suite it
does not earn its tokens.

Two things are true about that and both are worth stating:

- **It is a real result.** The ledger was added on the reasoning that a judge
  which knows what was already tried grades better. These ten fixtures say it
  does not — and the ledger costs up to 3000 tokens on every judged stop.
- **The suite cannot measure what the ledger is for.** Every fixture is a
  single-shot judgement over a fresh repository that already contains the ground
  truth, so a judge that reads the files needs no history. The ledger exists for
  the case none of these cover: day three, where the dead end was walked on day
  one and the repository has no memory of it. Both runs also sit at 100%, so the
  suite has no headroom to show a difference in either direction.

The honest reading is therefore *unmeasured*, not *useless* — and the fix is a
fixture the harness cannot express yet: two sequential judgements over a
repository that changes between them. Until that exists, the ledger is an
unmeasured bet, which is exactly what `karpathy-report.md` warns against, now
labelled as one instead of assumed to be fine.

### Measuring the loop, not the grader

The harness that runs the loop rather than the grader now exists:

```bash
npm run loop                              # 7 fixtures, offline, ~17s
npm run loop -- --ablate completion-audit
npm run loop -- --ablate ledger --judge
```

It runs several `Stop` rounds against a fixture repository that **changes between
them**, with a *scripted* worker standing in for the model — deterministic, free, and
reviewable. It reports which mechanism ended each loop, and separates "a fixture aims
at this and it never fires" from "no fixture reaches this".

**It found a real bug on its first run.** The failure reason Bandaid compared across
rounds contained only the check *command*, not its output — a constant — so the
plateau breaker fired after any two consecutive failing rounds regardless of progress,
and the "the verdict changed" progress signal could never fire at all. A fixture
landing one of four pipeline stages per round, reporting `only 1 of 4`, `only 2 of 4`,
`only 3 of 4`, was **terminated at round 3 before it could go green at round 4**.
Nothing in the repository could see that, because nothing ran the loop.

**What it still cannot measure is prose.** A script does not read the prompt, so
every prompt-block ablation comes back byte-identical to the baseline — and that is
the only possible outcome, not a finding. The 277-word completion audit is therefore
**not cut**, and its sunset note now names the experiment that would settle it
(`--worker claude`, a model-in-the-loop tier, deliberately unbuilt) instead of a flag
that exists and cannot answer.

**The evidence ledger's excuse is spent, and its answer is unchanged.** The fixture
`karpathy-report.md` asked for — two sequential judgements over a repository that
changes between them — now exists: round 1 lands a correct implementation, round 2
adds a test and reverts the implementation, so round 1's ledger entry describes a
worktree that is gone. With the judge on, the goal correctly stays open **with and
without the ledger**. Two independent harnesses now agree the ablation moves no
number. It is kept, because the judge is right in both arms and so there was no
headroom for the ledger to improve — and what would settle it is a trap invisible from
the files alone. If no such fixture can be built, that is the argument for deletion,
and it should be made in those terms rather than by another flat ablation.

That is ten fixtures on one theme with Haiku and criteria supplied — a floor,
not a general claim about the judge. What it buys is a regression detector: the
number moves when a prompt or a tier changes, which nothing here could tell you
before. `constraint-violated` is the one that is genuinely flaky (6 of 8 across
runs); the others have not missed.

The last two fixtures exist because the mechanisms they cover are prompt-shaped,
and a test that only asserts the prompt contains the right paragraph proves the
paragraph, not the behaviour. `blocked-by-environment` is the one that showed the
blocker path works end to end: the judge closed the goal and said, unprompted,
that the printer confirmation "is a recorded blocker not counted toward
completion."

---

## Credits

The design, the prompts, and the budgeting algorithm are Codex's; Bandaid is a
port. Derived from [openai/codex](https://github.com/openai/codex) (Apache-2.0):
`compact/prompt.md`, `compact/summary_prefix.md`, `goals/continuation.md`,
`goals/budget_limit.md`, `core/src/compact.rs`, and
`utils/string/src/truncate.rs`. See [NOTICE](NOTICE) for the file-by-file
attribution.

Apache-2.0. Not affiliated with OpenAI or Anthropic.
