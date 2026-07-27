---
name: bandaid-sweep
description: >
  Hunt for the same class of defect elsewhere in the repository after one instance has
  been found and fixed, where every finding must ship a command that fails right now.
  Use when a bug has just been fixed and the same shape could exist in other call sites,
  when the user asks whether a defect appears anywhere else, or when a goal's criteria
  mention a repo-wide fix. Produces .bandaid/artifacts/sweep/findings.json with executable
  reproductions. Not for a general "find bugs" pass, which is expensive and low yield.
---

# Sweep

A bug that was just fixed is evidence about a **class** of defect, not about one
line. Nothing in the ordinary loop asks "where else does this appear?" — and "I
fixed the bug" is a perfectly plausible continuation of finding one.

## The framing that gives this an exit status

There is no exit code for "are there bugs". Do not invent one. Instead:

> **Every finding must ship an executable reproduction, and the runtime — not
> you — runs it.**

```
reproExit !== 0  →  confirmed bug
reproExit === 0  →  discarded as unreproducible
```

That is the hallucination filter, and it is what makes a fan-out of read-only
agents safe to trust. It is also Karpathy's fourth principle applied to bugs
nobody had found yet: *write a test that reproduces it, then make it pass.*

A finding without a repro is discarded by the runtime. Not argued with,
discarded.

## 1. You need a seed

A sweep with no seed is a general bug hunt: expensive, low yield, and it
produces the kind of finding list everybody learns to ignore. The probe abstains
without one.

Seeds, in order of preference:

1. **The diff of the bug you just fixed.** "This was wrong here — find the same
   shape elsewhere."
2. **A `refuted` or `violation` entry in the evidence ledger.** Something already
   proven wrong once in this project.
3. **An explicit pattern from the user.**

## 2. Fan out, four ways

One agent searching one way finds one thing. Search four ways, in parallel,
read-only:

| lens | what it looks at |
|---|---|
| by-symbol | every call site of the function that was wrong |
| by-shape | the syntactic pattern, via Grep, across every language in the repo |
| by-neighbour | files that import, or are imported by, the file that was fixed |
| by-history | files touched in the same commits as the fixed file |

Each returns findings in the shape below. Dedupe by `file:line`.

Keep them strictly read-only — `Read`, `Grep`, `Glob`, nothing else. Separating
*propose* from *execute* is what keeps a fleet of agents out of a shell.

## 3. Write a repro that fails now

This is the part that takes the work, and it is the part that matters. Each
finding carries either:

- `repro.command` — a shell command expected to exit **non-zero right now**, or
- `repro.testFile` — a test file expected to **fail right now**.

A good repro is small, hermetic, and about the defect rather than about the
program:

```js
// good: fails now, passes when fixed, touches nothing
node -e "const a=require('assert'),r=require('./src/range');a.ok(!Number.isNaN(r.parseRange('5-').end))"
```

Do not write a repro that needs a network, a service, or a global install. It
will be executed in a throwaway worktree checked out at the goal's base commit,
with a 60-second ceiling, and anything reaching outside the repository escapes
that sandbox.

## 4. The report

`.bandaid/artifacts/sweep/findings.json`:

```json
{
  "schema": "bandaid.sweep/1",
  "baseSha": "<$BANDAID_BASE_SHA>",
  "scope": "src/",
  "findings": [
    {
      "id": "sw-0003",
      "title": "parseRange returns NaN for open-ended ranges",
      "pointer": "src/range.js:41",
      "why": "same shape as the bug fixed in src/cart.js:41",
      "repro": { "command": "node -e \"...\"" }
    }
  ]
}
```

Note what you do **not** write: `reproExit`, and `status`. The runtime sets
both, after it runs the repro. You cannot mark your own finding confirmed — the
same asymmetry that stops you writing `supported` into the evidence ledger, for
the same reason.

## 5. Dismissing one

`.bandaid/sweep-allow.json`, with a **required** reason:

```json
[{ "id": "sw-0007", "reason": "intentional: the legacy path is deleted in #412" }]
```

Dismissal is a recorded decision in a reviewable file, not a deletion.

## Reading the result

- **confirmed** — the repro failed. It is a real bug; fix it or record why not.
- **discarded-unreproducible** — the repro passed. Your reasoning was wrong, or
  the repro did not capture it. Either way it is not evidence, and the probe
  ignores it.
- **unconfirmed** — no git, so no throwaway worktree to run in. The probe will
  not fail on these; they are leads for a human.

## What this skill does not do

Property testing, fuzzing, or a general audit. Generating properties against the
changed surface and shrinking failures is the obvious next step and is
deliberately not built: it is a much larger machine, and this one has to earn
its place first.
