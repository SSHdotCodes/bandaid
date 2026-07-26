# The Best Goal: Codex `/goal` × Claude Code `/goal`

An analysis of how OpenAI Codex's goal feature works (from source, commit-pinned to a 2026-07-26 shallow clone of `openai/codex`), how Claude Code's `/goal` works (from official docs), where each fails on long tasks, and a combined design that neutralizes both failure sets.

All `file:line` citations below are relative to `codex-rs/` in the Codex repo.

---

## 1. How Codex's goal works

Codex's `/goal` is a stable, default-on subsystem (`Feature::Goals`, `features/src/lib.rs:1305`, `default_enabled: true`) living in its own crate, `ext/goal/` (~2,800 LOC). It is undocumented in the repo's `docs/` — everything below is from source.

### Storage

One goal per thread, persisted in SQLite (`state/src/model/thread_goal.rs:61`):

```
ThreadGoal { thread_id, goal_id, objective, status,
             token_budget: Option<i64>, tokens_used, time_used_seconds, ... }
```

- Objective capped at 4,000 chars (`protocol/src/protocol.rs:4053`).
- Statuses (`thread_goal.rs:14`): `Active | Paused | Blocked | UsageLimited | BudgetLimited | Complete`. Only `Active` drives continuation.
- Because it's in SQLite keyed by thread, the goal survives restarts, resumes, and forks (forks get a one-shot continuation deferral, `state/src/runtime/goals.rs:125`).

### The continuation loop

1. A turn ends; the core emits a thread-idle lifecycle event (`core/src/tasks/mod.rs:833` → `core/src/tasks/lifecycle.rs:42`).
2. The goal extension's `on_thread_idle` hook fires (`ext/goal/src/extension.rs:154`) → `continue_if_idle` (`ext/goal/src/runtime.rs:359`).
3. `continue_if_idle` takes a semaphore so a concurrent user `/goal clear` can't race, re-reads the goal from SQLite, and bails unless `status == Active` (`runtime.rs:399`).
4. It builds a **hidden steering prompt** — the rendered `templates/goals/continuation.md` with the objective inlined — as an internal context fragment, not a visible user message (`ext/goal/src/steering.rs:45-54`), and calls `try_start_turn_if_idle` (`runtime.rs:405`).
5. The injection gate (`core/src/session/inject.rs:45-130`) rejects if a turn is already running, plan mode is active, or user input is pending; otherwise a fresh normal agent turn starts with the continuation prompt prepended.
6. That turn ends → back to step 1. **There is no iteration cap.** The underlying agentic loop also has none (`core/src/session/turn.rs:394` comments that good compaction is the only guard against infinite loops).

Key property: the **full objective is re-injected verbatim every continuation**, straight from SQLite. Compaction can mangle the conversation history, but it can never lose the goal text.

### Who decides "done"

**The same main model, via prompt-pressured self-assessment.** There is no judge model and no programmatic check. The model gets three tools — `get_goal`, `create_goal`, `update_goal` (`ext/goal/src/spec.rs:9-11`) — and the loop ends when it calls `update_goal` with `complete` or `blocked`. Those are the *only* statuses the model may set; anything else is rejected with an explanatory error (`ext/goal/src/tool.rs:226-234`). Pause/resume/budget states belong to the user and system.

The entire completion guarantee is carried by the continuation prompt (`ext/goal/templates/goals/continuation.md`), which is genuinely well-engineered:

- **Anti-shrink** (lines 10-11, 25-28): "do not redefine success around a smaller or easier task"; "Do not substitute a narrower, safer, smaller, merely compatible, or easier-to-test solution because it is more likely to pass current tests."
- **Completion audit** (lines 30-41): treat completion as unproven; derive concrete requirements; find authoritative evidence per requirement; "Treat uncertain or indirect evidence as not achieved"; "The audit must prove completion, not merely fail to find obvious remaining work." If any requirement is unverified, "keep working instead of marking the goal complete."
- **Work-from-current-state** (line 20): trust the worktree over conversation memory — a deliberate hedge against compaction losing details.
- **Blocked hysteresis** (lines 43-49): the model may not declare `blocked` until *the same blocking condition has repeated for at least three consecutive goal turns*; never "merely because the work is hard, slow, uncertain, incomplete."

### How the loop stops

| Terminal path | Mechanism |
|---|---|
| Model verdict | `update_goal(complete\|blocked)` (`ext/goal/src/tool.rs:221-291`) |
| Token budget exhausted | SQL-side check `tokens_used >= token_budget` → `BudgetLimited` (`state/src/runtime/goals.rs:555-566`); a mid-turn "wrap up" steering item is injected (`ext/goal/src/extension.rs:400-410`, `templates/goals/budget_limit.md`) |
| Non-retryable turn error | goal force-set to `Blocked` (`ext/goal/src/extension.rs:308-332`) — the code comment is explicit: *"to prevent automatic continuation from looping and consuming tokens, as can happen with compaction errors"* |
| Usage limit hit | → `UsageLimited` (`runtime.rs:238`) |
| User action | `/goal pause`, `/goal clear`, plan mode (`tui/src/chatwidget/slash_dispatch.rs:783-808`; `inject.rs:58-63`) |

Two footnotes that matter: `token_budget` is optional and the tool schema says *"Omit unless explicitly requested"* (`spec.rs:36-40`) — so the **default configuration is an unbounded loop**. And `time_used_seconds` is tracked but **never enforced anywhere** — wall-clock is a metric, not a limit.

---

## 2. How Claude Code's `/goal` works

(From the official docs: <https://code.claude.com/docs/en/goal.md>.)

`/goal` sets a completion condition as a **session-scoped Stop hook**. After each turn, a separate small fast model (Haiku by default) receives the condition plus the conversation transcript and returns yes/no with a brief reason. On "no," the reason is injected as guidance and Claude immediately starts another turn; on "yes," the goal clears. The condition survives `--resume`/`--continue` (turn counts and token baselines reset). It does not auto-approve tools — long unattended runs need auto mode. The evaluator never runs tools or reads files; it judges only what appears in the transcript.

---

## 3. Failure points

The two designs fail in mirror-image ways. Codex trusts the worker; Claude Code trusts a witness who never left the courtroom.

### Codex

1. **Self-assessment bias — the fox audits the henhouse.** The model that did the work also grades it, and every guarantee is prompt pressure on that same model. The completion-audit prompt is strong, but a model that has convinced itself the work is done will read its own evidence charitably. Nothing independent ever checks.
2. **Unbounded by default.** No token budget unless the user asks, no time enforcement ever, no iteration cap. The failure the code itself anticipates — continuation looping on compaction errors, burning tokens (`extension.rs:316-319`) — is handled for *errors* but not for *plateaus*: a model making cosmetic "progress" each turn loops indefinitely.
3. **Blocked hysteresis is honor-system.** "Same blocker for 3 consecutive turns" is counted by the model in its head, not by the runtime. Nothing stops premature blocking, or the inverse — rephrasing the blocker each turn so it never "repeats."
4. **No ground truth.** Even a fully machine-checkable goal ("make `cargo test` pass") is still settled by self-assessment; there is no way to attach an exit-code oracle.

### Claude Code

1. **Transcript-only judge.** The Haiku evaluator can't run tools or read files. If the proof never surfaced in output — Claude ran the tests but the result scrolled through a tool call the transcript summarizes — the condition can't be confirmed. Users must phrase conditions as "run X and show the output."
2. **Compaction degrades the evidence.** After `/compact`, the goal persists but the evaluator now judges a summarized transcript; the granular evidence that would prove the condition may be gone. Codex explicitly hedges against this ("trust the worktree, not memory"); Claude Code's judge *has no worktree to trust*.
3. **Drift over 100+ turns.** The evaluator re-judges fresh each turn with no anchoring; an ambiguous condition or pivoting task lets its reasoning diverge from user intent.
4. **Cost compounds.** The full transcript goes to the evaluator every turn, untruncated.
5. **No budget machinery.** Nothing like Codex's `BudgetLimited` wrap-up flow; a runaway goal is stopped only by the user.

### Shared

Neither system has ground-truth verification, and both degrade under compaction — Codex because its worker's self-audit leans on history it may no longer have (partially mitigated by "inspect current state"), Claude Code because its judge's *only* input is that history.

---

## 4. The combined design: 3-tier verification

Take Codex's **state machine and loop discipline**, Claude Code's **independence principle**, and add the ground truth both lack. The tiers are ordered by authority: a higher tier's verdict is final and lower tiers are never consulted to overturn it.

### Tier 1 — Ground truth (new; neither system has it)

An optional user-supplied **check command** attached to the goal (`check: "npm test"`, `check: "cargo test && cargo clippy -- -Dwarnings"`). On every candidate completion, the runtime — not any model — runs it:

- Exit 0 → requirement objectively met (Tier 2 still confirms intent, see below).
- Non-zero → completion is **vetoed unconditionally**; the tail of the output is injected into the continuation prompt as the reason. No model, however convinced, can close the goal.

Immune to self-assessment bias, compaction, drift, and prompt injection. When the goal is fully machine-checkable, this tier alone is nearly sufficient — which is why "command-only" is the degenerate mode worth supporting.

### Tier 2 — Independent judge with hands (Claude Code's judge, given tools)

A separate evaluator (small fast model, headless) that judges **in the workspace, not from the transcript**. Its inputs:

- The objective, verbatim from persistent state (never from conversation history).
- An **evidence ledger**: an append-only file where the worker records claims with pointers ("auth flow done — see `src/auth.ts`, `npm test` output above"). The judge receives the ledger, not the transcript.
- **Read-only repo tools** (read files, run read-only commands) so it can verify claims directly: open the file, rerun the test, count the migrated call sites.

This fixes all four Claude Code judge failures at once: it sees what never surfaced in the transcript (it looks in the repo); compaction is irrelevant (it doesn't read the conversation); drift is anchored (verbatim objective + concrete evidence each time); cost is bounded (ledger ≪ transcript). And it fixes Codex's core flaw: the grader is not the worker.

Verdicts: `complete | keep-working(reason) | blocked-confirmed`. The `reason` becomes the next continuation's steering — Claude Code's best UX idea, preserved.

### Tier 3 — In-loop audit (Codex's prompt engineering, kept verbatim)

Every automatic continuation re-injects, Codex-style:

- The **full objective, verbatim from persistent state** — compaction-proof by construction.
- The **completion audit + anti-shrink + work-from-current-state** language from `continuation.md`. This is the cheapest tier and the first line of defense: most premature stops die here, before Tiers 1–2 ever spend a token.
- Current budget figures (tokens/turns/time used and remaining), so the model can pace itself.

### The state machine and loop discipline (from Codex, hardened)

- **Persistent goal state** outside the conversation: objective, status (`Active | Paused | Blocked | BudgetLimited | Complete`), budgets, ledger path. Survives restart/resume; user commands set/pause/resume/clear.
- **Budgets on by default, runtime-enforced.** Codex enforces tokens only if asked and never enforces time; the combined design defaults all three — turns, tokens, wall-clock — with generous ceilings. Near a ceiling: inject wrap-up steering (Codex's `budget_limit.md` flow). At the ceiling: hard stop to `BudgetLimited`. Not the model's decision.
- **Blocked hysteresis, runtime-counted.** Keep Codex's 3-strikes rule, but the *runtime* keeps the counter: the worker names its blocker; the judge (Tier 2) confirms "same blocker, no progress possible" on three consecutive evaluations before `Blocked` is accepted. No honor system in either direction.
- **Plateau breaker (new).** Codex blocks the goal on hard errors to stop token burn; add the soft equivalent: if the Tier 2 judge returns `keep-working` with substantially the same reason N consecutive times (no new evidence in the ledger), escalate to the user instead of looping. This is the failure mode neither system detects — indefinite cosmetic progress.
- **Verdict flow on a candidate stop:** Tier 3 already ran (in-prompt). Runtime runs Tier 1: fail → continue with the failure output as reason. Pass (or no check configured) → Tier 2 judge verifies in-workspace: `complete` → done; `keep-working` → continue with reason (bump plateau counter if the reason is stale); `blocked-confirmed` ×3 → `Blocked`.

### Mapping onto Claude Code primitives (design sketch, no code)

Everything above fits Claude Code's extension surface: goal state and ledger as JSON/markdown files in the session directory; the verdict flow as a **Stop hook** script that runs the check command, invokes the judge via headless `claude -p` with a read-only tool allowlist, and either blocks the stop (returning the continuation prompt with objective + audit language + reason) or lets it through; a small skill/slash command for `set | pause | resume | clear | status`. Budgets enforced by the hook from the transcript metadata it already receives. Pair with auto mode for unattended runs, exactly as the stock `/goal` docs advise.

---

## 5. Verdict table

| Failure mode | Codex | Claude Code | Combined design — neutralized by |
|---|---|---|---|
| Worker grades its own work | ✗ core flaw | ✓ (separate judge) | Tier 2: independent judge; Tier 1 outranks everyone |
| Judge can't see un-surfaced evidence | — (no judge) | ✗ transcript-only | Tier 2: judge reads the repo, not the transcript |
| Compaction destroys goal/evidence | ~ (objective re-injected; audit leans on state) | ✗ judge input is the transcript | Objective + ledger live outside the conversation (Tiers 2–3) |
| Unbounded runaway loop | ✗ budgets opt-in, time never enforced | ✗ no budgets at all | Turn/token/time budgets on by default, runtime-enforced |
| Plateau (cosmetic progress forever) | ✗ undetected | ✗ undetected | Plateau breaker: stale judge reasons → escalate to user |
| Premature / gamed "blocked" | ~ honor-system 3-strikes | — (no blocked concept) | Runtime-counted hysteresis, judge-confirmed |
| Evaluator cost compounds | ✓ (no evaluator) | ✗ full transcript per turn | Judge reads ledger + spot-checks; bounded per turn |
| Drift of the completion bar | ~ anti-shrink prompt only | ✗ fresh judgment each turn | Verbatim objective + Tier 1 oracle anchor every evaluation |
| Machine-checkable goals settled by opinion | ✗ | ✗ | Tier 1: exit code is the verdict |

Legend: ✓ handled · ~ partially handled · ✗ failure mode present · — not applicable.

**In one line:** Codex built the right loop with the wrong grader; Claude Code hired the right grader and blindfolded it. The best goal keeps Codex's persistent state machine, budgets, and audit prompts; gives Claude Code's independent judge eyes and hands in the workspace; and puts an exit code above both of them.
