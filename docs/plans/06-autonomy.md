# 6 — Autonomy: a permission-ask is not a reason to stop

## The failure

The goal system bounds itself six ways, and one of the six is a single line of
punctuation-counting.

`src/lib/goals.js:497-504`:

```js
function endsWithQuestionToUser(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const tail = text.slice(-400);
  const lastLine = tail.split('\n').filter((line) => line.trim()).pop() || '';
  return lastLine.trim().endsWith('?');
}
```

`src/lib/goals.js:534-536`:

```js
if (endsWithQuestionToUser(lastAssistantMessage)) {
  return { action: 'allow', goal, reason: 'model is asking the user a question' };
}
```

So a turn ending *"Should I proceed?"* releases the goal loop unconditionally. So
does *"Want me to keep going?"*, *"Shall I start on the next file?"*, and *"Does
that look right?"*. The entire continuation mechanism — the audit, the criteria,
the verifier tiers — is bypassed by a question mark.

This is the behaviour the objective names directly: *work on larger tasks without
stopping or asking for permission*.

## The reason it is there, which is a good one

`src/lib/goals.js:492-496`:

> Claude legitimately ends a turn to ask the user something. Blocking that would
> trap the user in a loop where the question is never actually asked, so a
> trailing question mark always wins over the continuation.

That failure is real and it is worse than the one this brief fixes. If Bandaid
blocks a turn whose final message was *"which of these two API keys should I
use?"*, the user never sees the question, the model is told to keep working, and
the loop runs until the continuation budget is spent — with the user watching a
spinner and the answer sitting in their head.

**So this brief is not "delete the check". It is "make the check discriminate",
and the discrimination has to be lopsided in favour of the existing behaviour.**

## The asymmetry, which sets the threshold

Two errors, wildly unequal:

| Error | Cost |
|---|---|
| Blocking a genuine question | The user is locked out of a conversation they are needed in. Recovers only when the budget runs out |
| Allowing a permission-ask | Today's behaviour. One turn ends early; the user types "continue" |

The second is a mild annoyance and the *status quo*. The first is a trap. So the
gate is **precision on the `allow` class** — of the questions we let through, how
many were genuine — and recall on `block` is whatever falls out. This mirrors
`eval/run.js:219-221` choosing `complete` as the positive class *"because calling
unfinished work done is the expensive error"*: pick the class whose false
positives hurt, and optimise that.

Concretely: any trailing line the classifier is not confident is a permission-ask
**allows the stop**. Uncertainty resolves to today's behaviour. That is the same
fail-open posture `runJudge` already takes — an unparseable verdict is *no vote*,
not a block (`src/lib/verify.js:158`).

## The config

```jsonc
"goals": {
  "autonomy": false,   // when true, a permission-ask does not release the loop
}
```

Default `false`. Env override `BANDAID_AUTONOMY`. This ships off because it changes
when Bandaid refuses to let a turn end, and every existing user would get that
change on upgrade without asking for it.

**Default-off has a consequence this brief must handle rather than ignore:** a
feature nobody switches on is a feature nobody tests in anger. So the last step of
this brief is explicit and separate — set `"autonomy": true` in
`~/.claude/bandaid/config.json` on the machine that asked for it, announce that it
was done, and say how to undo it. A feature added and left dormant on the one
machine whose owner requested it is not delivered.

## The classifier

Patterns over the trailing line, not a model. A subprocess judge on every Stop is
12–16 seconds (`README.md:726-729`) and this decision has to be free.

### Structure

```js
classifyTrailingQuestion(message) → { kind, confidence, matched }
// kind: 'genuine' | 'permission' | 'unknown'
```

`unknown` is the common case and it maps to `allow`. Only `permission` blocks.

**Permission-ask shapes** (block) — the model is asking to do something it has
already been told to do:

- Offers to continue: *shall I / should I / want me to / would you like me to /
  do you want me to / ready for me to* + a verb of work
- Progress checkpoints with no question content: *sound good? · look right? ·
  make sense? · any objections? · shall I carry on?*
- Permission for work already in scope: *ok to proceed? · can I go ahead? ·
  shall I continue with the rest?*

**Genuine-question shapes** (allow) — the environment genuinely cannot supply the
answer:

- A choice between named alternatives the model cannot rank: *which of `A` or
  `B`…*, *do you want X or Y?*
- A request for a value only the user has: a credential, an account, a URL, a
  deadline, a name, a preference
- A question about intent or acceptance: *did you mean…*, *is X in scope?*
- Anything containing an interrogative about a fact the model states it cannot
  determine: *what should the retry limit be?*
- **Any question following an explicit blocker.** If the goal already has a
  recorded blocker (`goal.blockers`, `src/lib/goals.js:308`) whose text overlaps
  the question, it is genuine by construction — the model already told us the
  environment cannot supply this.

That last rule is the strongest signal available and it is free, because the
blocker mechanism already exists and is already re-injected every turn.

### What the blocking continuation says

A new short section in `continuationPrompt`, rendered only when the classifier
blocked (so it costs nothing on any other path):

> You ended the turn asking permission to continue work that is already in scope
> for this objective. Decide it yourself, state the assumption you are proceeding
> under in one line, and keep working. If you genuinely need something only the
> user can supply — a credential, a decision between alternatives you cannot rank,
> a value you cannot derive — record it with `bandaid goal block "<what and what
> would unblock it>"` and continue with everything that is not blocked.

Two properties that matter: it names the *remedy* rather than scolding, and it
routes a real need into the blocker mechanism that already exists rather than
inventing a second channel. Word budget: ≤70 words, with its own ceiling.

## The fixture corpus

The corpus is the deliverable as much as the classifier is, and it must be real
text. Sources:

1. **This repository's own transcripts.** `readPromptsFromTranscript`
   (`src/lib/transcript.js`) already knows how to walk Claude Code's JSONL; a
   one-off script extracts final assistant lines ending in `?` from local
   transcripts. This is the only source of genuinely representative phrasing.
2. **Hand-written adversarial cases** for the shapes real data will not contain
   enough of — a genuine question phrased as an offer (*"Would you like me to use
   the staging key, or do you have a production one?"* — genuine, despite
   *"would you like me to"*), and a permission-ask phrased as a choice
   (*"Should I do the tests first or the docs first?"* — permission: both are in
   scope and the model can pick).

Those two adversarial rows are the point of the corpus. A pattern list that gets
them wrong is a pattern list that will misfire on real work, and they are the two
cases where the naive keyword approach fails in opposite directions.

Corpus lives at `eval/autonomy-fixtures/questions.jsonl`:

```jsonc
{"text":"Should I proceed with the migration?","expect":"permission","note":"in scope, already instructed"}
{"text":"Which of the two API keys should I use — staging or prod?","expect":"genuine","note":"cannot rank without the user"}
{"text":"Would you like me to use the staging key, or do you have a production one?","expect":"genuine","note":"offer phrasing, real question underneath"}
{"text":"Should I do the tests first or the docs first?","expect":"permission","note":"choice phrasing, both in scope, model can pick"}
```

## Tests

| Test | Asserts |
|---|---|
| `test/goals.test.js` | `decideOnStop` with `autonomy: false` allows on any trailing `?` — the existing behaviour, unchanged, asserted explicitly so a regression is loud |
| | With `autonomy: true`: a permission-ask returns `continue`; a genuine question returns `allow`; an `unknown` returns `allow` |
| | The blocker-overlap rule: a question matching a recorded blocker returns `allow` even when its phrasing looks like a permission-ask |
| new `test/autonomy.test.js` | The classifier over the whole corpus, reporting precision on `allow` and failing the suite below a stated floor |
| `test/prompts.snapshot.test.js` | New golden for the blocking continuation section, with a ceiling; existing goldens unchanged (this section must not appear on any other path) |
| `test/hooks.e2e.test.js` | Four runs: permission-ask and genuine question × flag on and off. Two exit codes, asserted both ways |

The four-run e2e matrix is the assertion that closes acceptance criterion 4's
"exercised by a test" clause.

## Measurement

Reported in the README, in the eval matrix's format:

```
$ node eval/autonomy-eval.js
  corpus     64 cases (41 permission, 23 genuine)
  precision  allow 100%   (of the stops it let through, how many were genuine)
  recall     block 78%    (of the permission-asks, how many it caught)
  unknown    9 cases fell through to allow
```

**The ship gate is `allow` precision at 100% on the corpus.** Not 98% —
one misclassified genuine question is one user locked out of their own session,
and there is no threshold argument that makes that acceptable when the fallback
(today's behaviour) costs a typed "continue".

If 100% precision cannot be reached at useful recall, the honest outcome is to
ship with lower recall — catching only the unambiguous *"shall I proceed?"* family
— and record the recall number. A classifier that catches half the permission-asks
and never traps the user is a real improvement; one that catches all of them and
traps the user occasionally is not.

## Measured, as built

```
$ npm run autonomy
  corpus     26 cases (16 permission, 10 genuine)
  GATE       genuine questions still allowed 10/10 (100%)
  recall     permission-asks caught 15/16 (94%)  — not the gate
  unknown    3 case(s) matched nothing and fell through to allow
```

**The gate holds: no genuine question is blocked.** Recall on permission-asks is
94%, and the single miss is the adversarial row written to be missed — *"Should I
do the tests first or the docs first?"*, choice phrasing around work that is
entirely in scope. It costs one turn, which is the acceptable direction.

**The metric was wrong first, and the harness caught it.** The initial scoring
computed one "allow precision" that counted a *missed permission-ask* as a
precision failure — conflating the harmless error with the harmful one and
reporting 91% with an exit code of 1 when nothing was actually wrong. The two
errors do not share a metric: the gate is "no genuine question blocked", and
recall is reported beside it and gates nothing.

**The paragraph came in over budget and was cut.** First draft was **79 words**
against the ≤70 this brief set. The enumeration of what counts as needing the user
— *"a credential, a decision between alternatives you cannot rank, a value you
cannot derive"* — duplicated what the blockers section already says two paragraphs
later, so it went. **57 words**, and it appears only on the turn that asked, so it
costs nothing on any other path. Its own golden and ceiling:
`continuation-asked-permission`.

**End to end**, five runs in `test/hooks.e2e.test.js`: permission-ask and genuine
question × flag off and on, plus an ordinary turn that must get no paragraph. Two
exit codes, asserted both ways. That is the clause in acceptance criterion 4 about
the continuation behaviour being exercised by a test.

**Turned on where it was asked for.** `~/.claude/bandaid/config.json` now contains
`{"goals":{"autonomy":true}}`. There was no config file before, so nothing was
overwritten. Deleting that file, or setting `autonomy` to `false`, restores the
previous behaviour exactly.

## Honest limits (to be added to the README)

- **Off by default**, because it changes when a turn is allowed to end. Turning it
  on is one config key and the README says which.
- **It is patterns, not comprehension.** A permission-ask phrased in a way the
  corpus does not contain falls through to `allow` — today's behaviour. Recall is
  reported and is not 100%.
- **The corpus is this repository's transcripts plus hand-written adversarial
  cases.** It is representative of one model working on one codebase. The two
  adversarial rows exist precisely because that is a narrow sample.
- **A blocked permission-ask spends a continuation.** So on a goal with two
  continuations left, two permission-asks exhaust the budget and the turn ends
  anyway. Brief 7 is what makes the budget large enough for this to matter.
- **The failure mode is asymmetric by design.** Uncertainty always allows the stop.
  This makes the feature weaker than it could be and is the deliberate trade.

## Files touched

`src/lib/goals.js` · `src/lib/config.js` · `src/lib/prompts.js` ·
new `src/lib/autonomy.js` · new `eval/autonomy-fixtures/questions.jsonl` ·
new `eval/autonomy-eval.js` · `README.md` · `test/goals.test.js` ·
new `test/autonomy.test.js` · `test/prompts.snapshot.test.js` ·
`test/hooks.e2e.test.js` · and finally `~/.claude/bandaid/config.json`, announced
