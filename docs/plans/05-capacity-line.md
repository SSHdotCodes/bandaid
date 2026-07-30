# 5 — One remaining-capacity line

## The failure

Five lines about two quantities (`src/lib/prompts.js:258-262`):

```
Budget:
- Continuation: 2 of 4
- Tokens used: 41823
- Token budget: none
- Tokens remaining: unbounded
```

Three of those five lines say nothing on a default configuration. `tokenBudget` is
`null` by default (`src/lib/config.js:56`), so *"Token budget: none"* and
*"Tokens remaining: unbounded"* are pure overhead on the overwhelmingly common
path, and *"Tokens used: 41823"* is a number with no threshold attached — a figure
the model cannot act on because nothing happens when it grows.

Briefs 1 and 4 add two more quantities. Rendered in the same style that is nine
lines, at which point the block is the largest thing in the prompt that nobody
reads.

## What replaces it

One line, naming only what binds:

```
Capacity: continuation 2/4 · 3h18m of 6h · ~35m remaining (4/10 tasks, range 20m–1h10m)
```

and on a default configuration, where nothing is bounded but the continuation
count:

```
Capacity: continuation 2/4
```

### The rules

1. **A quantity with no limit is not rendered.** No `tokenBudget` → no token
   clause. This alone removes two lines from every default-configuration prompt,
   which is how this brief can *lower* a ceiling while adding two features.
2. **The binding constraint goes first**, and the line says what happens when it
   binds. "continuation 4/4 — the next stop ends the turn" is actionable;
   "Continuation: 4 of 4" is trivia.
3. **Measured and estimated numbers are visually distinct.** `~` and a range
   prefix every estimate. This is not decoration — see below.
4. **The whole line is omitted when nothing is scarce.** An unbounded goal on its
   first continuation renders no capacity line at all.

## The honesty requirement

The four quantities are not of equal quality, and rendering them as one confident
line is how a useful signal becomes a misleading one.

**`tokensUsed` is a systematic undercount.** `estimateTokensUsed`
(`src/hooks/stop.js:58-66`) sums `approxTokenCount` over the *stored* call records
— and those are already truncated: `toolInputMaxTokens` 400,
`toolResultMaxTokens` 900 (`src/lib/config.js:24-27`), middle-truncated. A turn
whose real tool output was 50k tokens is counted as 900. `approxTokenCount` is
itself `ceil(bytes/4)` (`src/lib/tokens.js:20`), a Codex-compatible estimate rather
than a tokenizer.

So: elapsed time is measured. Continuations are counted. Tokens are a floor
presented as a figure. The ETA is an estimate with a stated range. The render
distinguishes them, and the README says which is which. Fixing the token
undercount is out of scope and is named as an open item rather than quietly
tolerated — the hook input may carry real usage figures, and if it does, that is a
one-line improvement worth its own future brief.

## Where the ceiling goes

`continuation-bare` is capped at 800 words (`test/prompts.snapshot.test.js`
`CEILINGS`). The header comment on that map is the standing instruction:

> These are not targets. Every one of them should be going down.

This brief is the one that has to make that true while briefs 1 and 4 push the
other way. The arithmetic it is accountable for:

| Change | Words |
|---|---|
| Remove the 5-line `Budget:` block | −18 |
| Remove brief 1's standalone `Elapsed:` block (folded in) | −14 |
| Add the capacity line, default config | +4 |
| Add the capacity line, fully configured | +22 |

Net on a default configuration: **down**. Net on a fully-configured goal: roughly
flat, for two features added. If the real numbers do not land there, the ceiling
is raised in a diff with the number in the commit message, which is the mechanism
working rather than failing.

Both goldens get re-recorded and read: `continuation-bare` and
`continuation-blocked` (960), plus the two goldens brief 1 added.

## Implementation

`formatBudgetLine` (`src/lib/prompts.js:62`) currently returns
`{ budget, used, remaining }` as pre-stringified values and is called once. It is
replaced by `capacityLine(goal, { now, eta })` returning a single string or `''`.

The `''` return is what keeps the no-config path byte-identical — the same pattern
`verificationSection` (`:78`) and `criteriaSection` (`:144`) already use to
disappear when they have nothing to say.

`budgetLimitPrompt` (`src/lib/prompts.js:469`) also renders budget state and must
agree with the new line rather than drifting from it; it keeps its own wording
(it is a wrap-up message, not a status line) but reads the same computation.

The line is behind a single ablation flag from day one — `--ablate capacity` in
brief 9's harness — because brief 10 cannot measure a block it cannot withhold,
and retrofitting the flag later means the block ships unmeasurable in the interim.

## Tests

| Test | Asserts |
|---|---|
| `test/prompts.snapshot.test.js` | Re-recorded `continuation-bare`, `continuation-blocked`, and brief 1's goldens; the recorded ceiling *decreases* for `continuation-bare` or the commit says why not |
| new cases in `test/verify.test.js` | The existing regex assertions over `continuationPrompt` (`test/verify.test.js:153-176`) still hold — this brief edits the prompt those guard |
| new `test/capacity.test.js` | Unbounded goal, first continuation → `''`; token budget set → token clause present; time budget set → time clause; all four → binding constraint first; estimate carries `~` and a range; a `null` ETA omits its clause without leaving a stray separator |
| `test/hooks.e2e.test.js` | The line reaches stderr on a real `stop.js` run; a default-config goal's stderr contains no token clause |

## Measurement

Two numbers, both recorded in the commit and one of them in the README:

1. **Word-count delta per golden**, before and after. This is the number the
   ceiling mechanism exists to make visible, and this brief's justification stands
   or falls on it.
2. **Ablation of the capacity line** on brief 9's harness — does withholding it
   change rounds-to-completion or the false-close rate? That result belongs to
   brief 10 and this brief's only obligation is to make it possible.

There is a real chance the honest answer is "the capacity line changes nothing
measurable", in which case brief 10 deletes it and the net effect of this brief is
that the prompt got 18 words shorter. **That is a good outcome** and is worth
saying now, before the measurement, so that it reads as a result rather than as a
retreat.

## Measured, as built

**The arithmetic the brief was accountable for, actual:**

| golden | before | after | delta |
|---|---|---|---|
| `continuation-bare` | 793 | 778 | **−15** |
| `continuation-blocked` | 946 | 931 | **−15** |
| `continuation-criteria` | 798 | 783 | **−15** |
| …and six more continuation goldens | | | **−15 each** |
| **net across ten changed goldens** | | | **−150 words** |

Every continuation prompt got **15 words shorter while gaining a wall-clock budget
and an ETA**. Ten ceilings came down rather than up, and each now sits five words
above its golden — the smallest headroom that does not make an inconsequential
rewording fail the suite.

The saving comes from the rule, not from terse wording: three of the four lines
this replaced said `none` or `unbounded` on a default configuration, and one
reported a number with no threshold attached. An absent clause is cheaper and
clearer than an unbounded one.

**End to end**, with real task durations of 10/12/9 minutes and five tasks left:

```
Capacity: continuation 1/2 · ~50m left (5 tasks, 45m–1h)
```

Asserted in `test/hooks.e2e.test.js` off the real `stop.js` stderr, including that
`Budget:` no longer appears anywhere.

**Two bugs this brief surfaced and fixed, neither of them its own:**

- `bandaid tasks | head -4` died with an unhandled `EPIPE` stack trace. Any long
  CLI output piped to `head` did. One handler.
- The new e2e test called `tasks.observe` **in this process**, and the state dir is
  chosen by an env var only the *child* receives — so it wrote into the real
  `~/.claude/bandaid`. Found, removed, and the test now writes its fixture with
  `fs`. The suite is subprocess-only for exactly this reason, and the comment now
  says so.

## Honest limits (to be added to the README)

- **`tokensUsed` is a floor, not a count.** It sums truncated digests at 4 bytes
  per token, so a token-heavy turn is undercounted, sometimes by a large factor. A
  token budget set against it is therefore looser than it looks. The clause is
  rendered with the same `~` marker as an estimate for that reason.
- **The line reports capacity, not progress.** Knowing three of ten tasks are done
  says nothing about whether the remaining seven are the hard ones. Criteria
  coverage (`bandaid self-check`) is the progress signal; this is the fuel gauge.
- **The binding-constraint ordering is a heuristic.** With two constraints at
  similar fractions the choice of which leads is arbitrary and the line will
  occasionally emphasise the wrong one. Both are still shown.

## Files touched

`src/lib/prompts.js` · `src/hooks/stop.js` · `README.md` ·
`test/prompts.snapshot.test.js` · `test/verify.test.js` ·
new `test/capacity.test.js` · `test/hooks.e2e.test.js` · four goldens re-recorded
