# Bandaid

Replaces Claude Code's compaction and goal handling with Codex's.

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
| `Stop` | The goal system — see below. |

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

**It is bounded in four independent ways**, because a stop hook that can loop is
worse than no stop hook:

- `stop_hook_active` is honoured — Claude Code's own loop guard always wins.
- A goal may block at most `maxContinuations` times (default **2**), then gives up.
- Turns that changed nothing (no `Edit`/`Write`/`Bash`/`Task`) are never audited.
- If Claude ended its turn asking *you* a question, the stop is always allowed.

Worst case is two extra rounds on a goal the model cannot finish. Set
`goals.mode` to `"explicit"` if you only want `/bandaid:goal` to arm it, or
`"off"` to disable it entirely.

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
| `/bandaid:goal <objective>` | Set an explicit objective |
| `/bandaid:goal-status` | Show the objective and its continuation budget |
| `/bandaid:goal-done` | Close the objective |

The `bandaid` CLI has the same surface plus `install`, `uninstall`, `doctor`,
`inspect`, `sessions`, `prompt`, and `on`/`off`.

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
    "maxContinuations": 2,
    "tokenBudget": null,
    "skipTrivialTurns": true
  }
}
```

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
- **The goal system depends on the model cooperating** to run the completion
  command. When it does not, the continuation cap ends the loop and the turn stops
  normally.
- **Tested against Claude Code 2.1.220.** Hook input field names are product
  internals and could change; `bandaid doctor` and the end-to-end tests are how
  you find out.

---

## Development

```bash
npm test          # 59 tests, no dependencies
node bin/bandaid.js doctor
```

`test/hooks.e2e.test.js` runs the real hook scripts the way Claude Code runs them
— JSON on stdin, meaning carried by the exit code — against a throwaway state
directory. It is the suite that catches an integration break.

---

## Credits

The design, the prompts, and the budgeting algorithm are Codex's; Bandaid is a
port. Derived from [openai/codex](https://github.com/openai/codex) (Apache-2.0):
`compact/prompt.md`, `compact/summary_prefix.md`, `goals/continuation.md`,
`goals/budget_limit.md`, `core/src/compact.rs`, and
`utils/string/src/truncate.rs`. See [NOTICE](NOTICE) for the file-by-file
attribution.

Apache-2.0. Not affiliated with OpenAI or Anthropic.
