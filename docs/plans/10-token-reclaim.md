# 10 — Pay the bill: ablate everything, delete the losers

## Why this brief exists

Nine briefs of new mechanism and new prose, landing in a repository whose prompt
ceilings *"are not targets. Every one of them should be going down."*
(`test/prompts.snapshot.test.js` header) and whose standing rule is *"do not add
prompt prose without an eval"* (`karpathy-report.md:242`).

Briefs 1–8 add the prose. Brief 9 builds the instrument. This brief is the bill,
and it is the brief that makes the other nine honest rather than merely shipped.

Its success condition is **deletions**. A run of this brief that keeps everything
is a suspicious result, not a clean bill of health.

## The bar

`README.md:849-851`:

> A mechanism whose ablation moves no number is a mechanism to delete, and saying
> so in advance is what makes deleting it a result rather than a defeat.

So the predictions go here, before the numbers, in writing:

| Block | Prediction | If wrong |
|---|---|---|
| Completion audit (277 words) | Moves nothing on the scripted harness; the pre-authorised cut applies | Keep it and delete the sunset note |
| Evidence ledger (≤3000 tokens/judged stop) | Moves the `ledger-moving` fixture and nothing else | If it moves nothing there either, delete it — the null result becomes final |
| `Elapsed:` block / capacity line | Moves nothing measurable on a scripted worker; kept on a stated non-measurement argument or deleted | Whichever the number says |
| ETA clause | Cannot be measured by a scripted worker at all; stands on brief 4's backtest alone | — |
| Autonomy paragraph | Moves the release decision on any fixture whose worker ends a round with a permission-ask | If not, the paragraph goes and the classifier stays |
| Progress refund | Moves `converging` rounds down and `stalling` rounds down | If either rises, brief 7 does not ship |
| Plateau breaker | Fires zero times (already predicted in brief 8) | Keep it, documented as check-command-only |
| `Progress visibility` / TodoWrite paragraph | Untested since it was written; likely earns its 44 words only if brief 3 shows the model actually uses TodoWrite | Delete if brief 3's usage number is low and ablation moves nothing |

Eight predictions. Writing them down is what converts each outcome into a result.

## The matrix

Every prompt block gets an ablation seam in brief 9 — that is a hard requirement of
brief 9, not an aspiration, and its harness tests assert the withheld text is
genuinely absent from captured stderr.

```
node eval/loop.js --ablate completion-audit
node eval/loop.js --ablate ledger
node eval/loop.js --ablate elapsed
node eval/loop.js --ablate capacity
node eval/loop.js --ablate autonomy
node eval/loop.js --ablate refund
node eval/loop.js --ablate progress-visibility
node eval/loop.js --ablate fidelity
node eval/run.js  --ablate completion-audit     # newly expressible; see below
```

Plus the existing four from `eval/run.js` (`criteria`, `constraints`, `blockers`,
`ledger`), re-run so the whole picture is one table rather than two vintages.

Reported as one table in the README, in the format `README.md:826-832` already uses:

```
                            eval/run.js          eval/loop.js
                        acc   prec  recall   releases  rounds  false-close
baseline                10/10 100%  100%     5/6       3/2/4   0
--ablate completion-audit  …     …      …        …         …       …
--ablate ledger         10/10 100%  100%     …         …       …
```

## The pre-authorised deletion

`src/lib/prompts.js:214-223` contains a promise the codebase made to itself:

> ~277 words asking the model to grade its own work honestly … Cut these paragraphs
> to their first and last sentence once `npm run eval -- --ablate
> completion-audit` shows precision unchanged.

That flag has never existed. Brief 9 makes the loop-level version expressible; a
narrower version becomes expressible in `eval/run.js` too, since with a loop harness
the audit's text can be withheld from a first round and the *judge* then run on the
resulting state.

So this brief runs it and honours the outcome. Three cases:

1. **Precision unchanged** → make the cut. 277 words become roughly 40. This is
   the single largest token reclamation available anywhere in Bandaid, and it was
   pre-authorised by whoever wrote that comment.
2. **Precision drops** → keep the paragraphs, **delete the sunset note**, and
   record the number. A dated promise that has been tested and refuted should stop
   being a promise.
3. **The harness cannot measure it well enough to decide** → say so, and replace
   the open-ended note with the specific thing that would settle it (brief 9 names
   it: `--worker claude`). A note that names its own experiment is useful; one that
   names a flag that does not exist is debt.

Case 3 is a real possibility and must not be treated as case 1. The scripted worker
measures the loop's mechanics, not persuasion (brief 9, "What this cannot measure"),
and the completion audit is prose aimed squarely at persuasion. **The honest default
here is case 3**, and it would be a mistake to read a flat number from a scripted
worker as licence to cut 237 words of prose written for a model.

## The evidence ledger, finally decidable

Withholding it changed nothing on the ten single-shot fixtures
(`README.md:853-861`), and the README's reading is that this is *unmeasured* rather
than *useless*, because *"every fixture is a single-shot judgement over a fresh
repository that already contains the ground truth, so a judge that reads the files
needs no history."*

Brief 9's `ledger-moving` fixture removes that excuse: two sequential judgements
over a repository that changes between them, with the second round facing evidence
from the first that a revert has made stale.

- **Moves the round-2 verdict** → the ledger earns its ≤3000 tokens and the
  README's provisional label becomes a measurement.
- **Moves nothing** → delete it. `src/lib/evidence.js` (279 lines), its render in
  the continuation prompt, `evidence show|add`, the three eval fixtures that exist
  to catch a judge believing it, and the `evidenceSummary` plumbing through
  `src/hooks/stop.js:46-56`. That is a large deletion and it is the correct one if
  the number says so.

The second outcome would remove a mechanism this repository built deliberately and
documented well. That is what the standard requires, and `README.md:865-867` already
says so: *"It is a real result. The ledger was added on the reasoning that a judge
which knows what was already tried grades better. These ten fixtures say it does
not."*

## Ceilings, renegotiated once

All 21 ceilings in `test/prompts.snapshot.test.js` `CEILINGS` are reviewed at the
end of this brief, once, with the final prose in place, and the table of
before/after goes in the commit. Targets to beat:

| Golden | Before | Target |
|---|---|---|
| `continuation-bare` | 800 | below 800 with briefs 1, 4, 5, 6, 7 landed |
| `continuation-blocked` | 960 | below 960 |
| `judge-bare` | 195 | unchanged (untouched by this work) |

If `continuation-bare` cannot go below 800 after the completion-audit decision, the
ceiling is raised with the number in the commit message and the README records that
the prompt got longer and why. That is the mechanism working. Quietly raising it
would not be.

## The bill, paid

### The prompt-block matrix is completely flat, and that is not a licence to cut

```
$ npm run loop -- --ablate <block>
baseline               correct 7/7   check 2 · stall 0 · plateau 3 · blocker 1 · rounds-exhausted 1
--ablate completion-audit  7/7   ...identical...
--ablate fidelity          7/7   ...identical...
--ablate progress-visibility 7/7  ...identical...
--ablate capacity          7/7   ...identical...
--ablate elapsed           7/7   ...identical...
```

Every ablation is byte-identical to the baseline. **This measures nothing about the
prose**, and reading it as a result would be the single worst mistake available here.
The worker is a script; a script does not read the prompt. Withholding prose
therefore *cannot* change the outcome, and a flat row is the only possible outcome.

Brief 9 said this in advance and brief 10 predicted case 3 would apply. It does.

**So the 277-word completion audit is not cut**, and its sunset note is rewritten
rather than honoured or deleted: the flag it named (`npm run eval -- --ablate
completion-audit`) now exists and still cannot answer the question, because the judge
never sees the continuation prompt and the loop worker never reads it. What would
settle it is named instead: `--worker claude`, a model-in-the-loop tier that is
deliberately unbuilt.

Confirmed as a by-product: the ablation seam does work. Withholding the audit removes
**exactly 277 words** from the rendered prompt — matching `karpathy-report.md`'s
independent count — and `test/loop-harness.test.js` asserts the block really
disappears, so a future flat row cannot be a silently broken flag.

### The evidence ledger: the excuse is gone, and the answer did not change

`karpathy-report.md:345-351` said the ledger's null result was *unmeasured* rather
than *useless*, because every fixture was "a single-shot judgement over a fresh
repository", and named what would settle it: two sequential judgements over a
repository that changes between them. **That fixture now exists.**

`ledger-moving`, run with the judge on: round 1 lands a correct implementation and no
test (criteria 1 and 2 met, 3 not, so the goal cannot legitimately close). Round 2
adds the test and **reverts the implementation to a stub** — so criterion 3 is now met,
1 and 2 are not, and round 1's ledger entry describes a worktree that no longer
exists. The trap is that the ledger says the implementation works.

```
WITH ledger     status=active  rounds=3  never closed   ✓ correct
WITHOUT ledger  status=active  rounds=3  never closed   ✓ correct
```

The judge was not fooled either way. **Withholding the ledger changed nothing, now
including on the moving-repository fixture that was supposed to be where it mattered.**

**Verdict: keep, with the ambiguity written down.** Two independent harnesses now
agree its ablation moves no number, and the "the suite cannot express this" defence
is spent. What stops this being a deletion is headroom, not sentiment: the judge is
*correct* in both arms, so there was nothing for the ledger to improve. The trap may
simply be too easy — `module.exports = {}` is obvious from reading one file, so
history is not needed to avoid it.

Naming the experiment that would settle it, as the brief requires: a fixture where
the judge **needs** history to be right — a trap invisible from the files alone, such
as an approach that was tried, failed for a reason the code does not record, and
looks plausible on inspection. If no such fixture can be constructed, that is itself
the argument for deletion, and it should be made in those terms rather than by
another flat ablation.

### The eight predictions, scored

| # | Prediction | Outcome |
|---|---|---|
| 1 | Completion audit moves nothing; the pre-authorised cut applies | **Half right, and the half that matters is wrong.** It moves nothing *on a scripted worker*, which cannot license the cut. Not cut; note rewritten |
| 2 | Ledger moves the `ledger-moving` fixture and nothing else | **Wrong.** It moves nothing there either. Kept on headroom, not on evidence |
| 3 | Elapsed / capacity move nothing measurable | **Right**, and for the same unusable reason as #1 |
| 4 | ETA unmeasurable by this harness | **Right.** It rests on `npm run eta` alone |
| 5 | Autonomy paragraph moves any fixture ending in a permission-ask | **Untested.** No loop fixture ends a round with a trailing question; that is a coverage gap, now named |
| 6 | Progress refund moves `converging` and `stalling` rounds down | **Right, and it found a bug doing it.** `slow-converging` gained 2 refunds and finishes at round 4 instead of dying at round 3 |
| 7 | Plateau breaker fires zero times | **Badly wrong.** It ends 3 of 4 stuck loops — and was killing converging ones |
| 8 | `Progress visibility` / TodoWrite paragraph likely unearned | **Untested by ablation**, but brief 3 measured the premise: 1 of 15 sessions used a task tool at all |

Four of eight predictions were wrong, and the two that were most wrong — #2 and #7 —
were wrong in the direction of "this mechanism is dead". Writing them down in advance
is what makes that a result.

### Token accounting, net

| change | words |
|---|---|
| brief 1 added `Elapsed:` | +15 per continuation |
| brief 5 removed the four-line `Budget:` block and folded `Elapsed:` in | **−15 per continuation, ×10 goldens = −150** |
| brief 6 added the autonomy paragraph | +57, and only on the turn that asked |
| brief 7 added `(N earned)` | +3, and only after a refund |
| brief 10 removed | **nothing** |

**Net on an ordinary continuation: −15 words, having added a wall-clock budget, an
ETA and an earned leash.** Every one of the 23 ceilings in
`test/prompts.snapshot.test.js` came down or is new. Nothing was deleted, and the
reason is stated rather than implied: the only harness that could justify deleting
prose cannot read prose.

## Tests

| Test | Asserts |
|---|---|
| `test/prompts.snapshot.test.js` | Every golden re-recorded; the `CEILINGS` map still has an entry per golden (the existing *"so a new prompt cannot slip in unmeasured"* test); ceilings reflect the final prose |
| whichever tests belong to deleted mechanisms | Deleted with them. A test asserting a mechanism nobody reaches is worse than no test — it reports coverage of a dead path |
| `test/loop-harness.test.js` | Each ablation flag used here genuinely withholds its block |

## Measurement

This brief **is** measurement. Its deliverable is a table and a set of deletions,
both in the README, plus one paragraph per decision explaining what moved and what
did not.

Three things must appear in that write-up whatever the numbers say:

1. **Every prediction from the table above, scored.** Including the wrong ones.
   `karpathy-report.md` §7 is the model for this — it re-scores its own four claims
   against what shipped, and the section titled *"The part that did not go the way
   it was argued for"* is the most useful part of the document.
2. **Every mechanism that ended zero loops**, from brief 9's `ended by` row.
3. **The token accounting**: what the nine briefs added to each injected prompt,
   what this brief removed, and the net. If the net is positive, say so as a number
   rather than as a paragraph.

## Honest limits (to be added to the README)

- **A scripted worker cannot measure persuasion.** Every ablation number here is
  about the loop's mechanics. Prose written to change what a model chooses to do is
  not measured by this brief and is not licensed to be cut by it. Where a block
  survives on that argument, the argument is stated rather than implied.
- **Six loop fixtures and ten judge fixtures on one theme.** A regression detector,
  not a general claim — the same caveat both harnesses already carry.
- **Deletions are irreversible in a way keeps are not.** A block kept on a null
  result costs tokens; a block deleted on a bad measurement costs a mechanism. So
  where a number is ambiguous the tie goes to keeping, *with the ambiguity written
  down and the experiment that would settle it named* — never to keeping quietly.
- **This brief cannot measure itself.** Whether the reclaimed tokens improved
  anything is the next harness's question, and nothing here should claim otherwise.

## Files touched

`README.md` (the table, the deletions, the scored predictions) ·
`src/lib/prompts.js` (the cuts) · `test/prompts.snapshot.test.js` (ceilings,
goldens) · potentially `src/lib/evidence.js` + `src/hooks/stop.js` +
`bin/bandaid.js` + three `eval/fixtures/` (if the ledger goes) · potentially
`src/lib/goals.js` (if the plateau breaker goes) · every golden re-recorded
