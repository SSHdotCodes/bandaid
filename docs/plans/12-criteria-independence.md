# Brief 12 — Criteria written by something that is not graded on them

**Discharges** `harness-report.md` §3.2. **Adds** `verify.runCriteria`,
`goal criteria --derive`, an acceptance gate in `commands/goal.md`,
`eval/criteria.js` and three fixtures.

## The problem

`commands/goal.md` step 3 had the worker derive 2–5 acceptance criteria, then work
toward them, then be graded against them by a judge reading the same list.

`karpathy-report.md` found half of this and fixed it: worker and judge used to
derive separate rubrics, so a "continue" this turn and a "continue" next turn were
not necessarily about the same bar. Sharing one fixed list fixed that. It left the
prior question untouched — **who writes the list.**

[arXiv 2605.25665](https://arxiv.org/pdf/2605.25665) is blunt that the author must
not be the party bound: contracts should "originate from domain experts or verified
requirements systems, never from the agent itself." The failure that predicts is not
a wrong criterion but a *missing* one — a list individually reasonable and
collectively smaller than the objective. Nothing downstream catches it, because from
the moment it is recorded the short list **is** the bar, for worker and judge alike.

The old prompt tried to hold this with prose: *"Cover the objective as written and
nothing more: criteria that quietly narrow it become the new, smaller goal."*
Asking the examinee to write a fair exam is the shape of instruction this repository
has a standing rule against.

## The mechanism

`goal criteria --derive -- "<fallback>" "<fallback>"`.

`verify.runCriteria` spawns exactly as `runJudge` does — separate process,
`--model haiku`, `Read Grep Glob` allowed, `Edit Write Bash Task` disallowed,
`BANDAID_ENABLED=0` for the recursion guard. It is seeded with **the objective as
written and the repository, and not the conversation**: nothing about how the work
is going or what the worker intends.

`criteriaSource` records provenance: `independent`, `model` (the worker's own), or
`user`. `setCriteria` still refuses to overwrite without `{replace: true}`, so the
fixed-once discipline is unchanged — this brief changes *who authors*, not *when it
freezes*.

**Degradation is explicit.** A missing CLI, a crash, a timeout, or output that does
not follow the contract all return `null`, and the CLI falls back to the worker's
list and records `criteriaSource: 'model'`. Null is not failure; it is the signal to
fall back *and say so*. The same fail-open posture the judge takes.

**The acceptance gate.** `commands/goal.md` now relays the criteria and stops. Work
does not start in the goal-setting turn. Criteria are fixed once and the cheapest
moment to fix a wrong bar is before anything is built against it — and this is also
the one place Claude Code's `/goal` is right where Bandaid was not: its condition is
written by the user, the only party with no stake in grading. Deriving independently
and then having the user accept is the same principle with the typing cost moved.

## Measurement

`npm run criteria`. Three fixtures, each a narrowing trap: an objective with an
awkward half (`awkward-half`), a quantifier plus a disposal clause
(`every-callsite`), two negative clauses after one positive (`negative-clause`).
Each ships hand-written ground-truth requirements and a recorded worker list.

```
fixture            reqs  worker   independent  missed by worker
awkward-half       3     33%      100%         fallback, callers
every-callsite     3     33%      78%          exhaustive, deleted
negative-clause    3     33%      89%          column-order, no-deps

worker       33%
independent  89%      stable across 9 samples (--repeat 3)
```

### The caveat is bigger than the number

The independent arm is a real measurement: nine stochastic samples scored against
ground truth written before the arm ran.

**The worker arm is not.** It is three lists the fixture author wrote, knowing what
would be scored, to stand in for what a worker plausibly writes. All three landing on
exactly 33% is a fact about the author. The honest claim this suite supports is:
*the independent author reaches the awkward half of an objective.* The claim it does
**not** support is *by 56 points more than a worker would*.

The fixture that would settle it needs criteria captured from real mid-conversation
goal-setting. It does not exist, and this is the same shape of gap as brief 9's
scripted worker: measurable in principle, unmeasured here, named rather than
implied.

Coverage is also regex over criterion text — it rewards naming the right noun, which
is a proxy for meaning it. Both limits are recorded at the top of `eval/criteria.js`.

### Deletion condition, stated in advance

Per `README.md:849-851`, a mechanism whose ablation moves no number is a mechanism to
delete. If a real-worker baseline ever shows independent derivation covering no more
of the ground truth, this goes and `commands/goal.md` reverts to worker-authored
criteria. The harness prints that verdict itself rather than leaving it to be argued.

## Prompt cost

`criteriaPrompt` is a new golden — 187 words, ceiling 192. It is spent **once per
goal in a subprocess**, before the loop starts, and never on a continuation. It gets
a ceiling anyway: the rule has no exemption for prose that is spent somewhere
cheaper.

All ten continuation goldens are unmoved.
