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

**It is bounded in five independent ways**, because a stop hook that can loop is
worse than no stop hook:

- `stop_hook_active` is honoured — Claude Code's own loop guard always wins.
- A goal may block at most `maxContinuations` times, then gives up.
- Turns that changed nothing (no `Edit`/`Write`/`Bash`/`Task`) are never audited.
- If Claude ended its turn asking *you* a question, the stop is always allowed.
- Two identical verification failures in a row end the loop early (see below).

Worst case is two extra rounds on a goal the model cannot finish. Set
`goals.mode` to `"explicit"` if you only want `/bandaid:goal` to arm it, or
`"off"` to disable it entirely.

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
| `/bandaid:goal <objective> [--check "<cmd>"]` | Set an explicit objective, optionally with a command that proves it done |
| `/bandaid:goal-status` | Show the objective, its check, and its continuation budget |
| `/bandaid:goal-done` | Close the objective |
| `/bandaid:verify` | Run the check and the judge now, and show the verdict |

The `bandaid` CLI has the same surface plus `install`, `uninstall`, `doctor`,
`inspect`, `sessions`, `prompt`, `goal criteria`, and `on`/`off`.

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
    "skipTrivialTurns": true,
    "check": null,                  // shell command; exit 0 closes any goal
    "judge": false,                 // independent read-only verifier
    "judgeModel": "haiku",
    "verifyTimeoutMs": 120000,      // ceiling for one check or one judge run
    "plateauLimit": 2               // identical failures before giving up
  }
}
```

A check command is the cheapest large win here. With one attached, looping is
safe — the loop cannot end on a false positive — which is why attaching one
raises the continuation cap on its own.

Env overrides for one-off runs: `BANDAID_ENABLED`, `BANDAID_COMPACT`,
`BANDAID_GOALS`, `BANDAID_GOAL_MODE`, `BANDAID_MAX_CONTINUATIONS`,
`BANDAID_USER_MESSAGE_MAX_TOKENS`, `BANDAID_DIGEST_BUDGET_TOKENS`,
`BANDAID_HOME`, `BANDAID_DEBUG`.

`bandaid off` is the kill switch; it disables every hook without uninstalling.

---

## Where your data goes

`~/.claude/bandaid/sessions/<session-id>/` — `prompts.jsonl` (verbatim),
`turns.jsonl` (tool digests), `goal.json`, `summaries.jsonl`, `meta.json`. All
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
- **The judge costs a subprocess and a few seconds** (~9s with Haiku) on stops
  that would otherwise be blocked, and needs `claude` on `PATH`. It is off by
  default for that reason. If it cannot run it abstains silently rather than
  blocking.
- **Tested against Claude Code 2.1.220.** Hook input field names are product
  internals and could change; `bandaid doctor` and the end-to-end tests are how
  you find out.

---

## Development

```bash
npm test          # 125 tests, no dependencies, no network
npm run eval      # measures the judge against fixtures; needs `claude` on PATH
node bin/bandaid.js doctor
```

`test/hooks.e2e.test.js` runs the real hook scripts the way Claude Code runs them
— JSON on stdin, meaning carried by the exit code — against a throwaway state
directory. It is the suite that catches an integration break.

`test/prompts.snapshot.test.js` holds every injected prompt as a golden file in
`eval/snapshots/`. Roughly a thousand words of instruction reach the model, and
without these a prompt edit broke no test and was invisible in review. Refresh
with `UPDATE_SNAPSHOTS=1 npm test` and read the diff.

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

```
$ npm run eval -- --repeat 3
  accuracy   15/15 (100%)
  confusion  complete-when-complete 3   complete-when-not 0
             continue-when-not      12   continue-when-complete 0
  precision  100%  (of the goals it closed, how many were really done)
  recall     100%  (of the goals really done, how many it closed)
```

That is five fixtures on one theme with Haiku and criteria supplied — a floor,
not a general claim about the judge. What it buys is a regression detector: the
number moves when a prompt or a tier changes, which nothing here could tell you
before.

---

## Credits

The design, the prompts, and the budgeting algorithm are Codex's; Bandaid is a
port. Derived from [openai/codex](https://github.com/openai/codex) (Apache-2.0):
`compact/prompt.md`, `compact/summary_prefix.md`, `goals/continuation.md`,
`goals/budget_limit.md`, `core/src/compact.rs`, and
`utils/string/src/truncate.rs`. See [NOTICE](NOTICE) for the file-by-file
attribution.

Apache-2.0. Not affiliated with OpenAI or Anthropic.
