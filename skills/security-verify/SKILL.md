---
name: bandaid-security-verify
description: >
  Check what this work introduced for security defects — credentials written into the
  repository, new dependency advisories, and injection or authorization gaps reachable
  from untrusted input in the diff. Use when a goal touches auth, input handling, secrets,
  dependencies, or a request path, when a Bandaid security probe reports a finding, or
  when the user asks whether a change is safe to ship. Grades what the diff added, not
  what the repository already contained. Not a substitute for a real audit.
---

# Security verification

Three passes that answer three unrelated questions. They are separate on purpose
and only the composite verdict is one number.

## The framing that makes this a gate rather than a report

**Grade the delta, not the codebase.** Absolute counts fail every real
repository instantly, and a gate that fails on day one is switched off on day
two. Every pass below compares against a baseline or against the diff, so what
fails is what *this work* introduced.

## S1 — credentials in the diff

Bandaid's built-in, zero dependencies, no configuration:

```json
{ "id": "secrets", "builtin": "secrets", "when": { "changed": ["**"] } }
```

High-precision patterns only — AWS key ids, private key headers, GitHub and
Anthropic and Slack tokens, JWTs, connection strings with an inline password. No
entropy heuristic: that is where the false positives live, and a scanner that
cries wolf gets muted.

- A hit **in the diff or in a new untracked file** fails. The work put it there.
- A hit in a file this goal never touched is not this goal's problem.
- A deliberate one — a fixture with a fake key — goes in
  `.bandaid/secrets-allow.txt` as `file:line:pattern`, one per line.

A secret that is already committed is worth telling the user about **in your
final message**, plainly, including that rotating it matters more than deleting
it. Do not quietly rewrite history to hide it.

## S2 — dependency advisories, diffed against a baseline

Whatever the project already has: `npm audit --json`, `pnpm audit --json`,
`pip-audit -f json`, `cargo audit --json`, `govulncheck -json`, `semgrep --json`,
`gitleaks`. Missing binary → exit 78. Do not install one.

The verdict is a **set difference**, not a count:

```
findings_now − findings_in_baseline ≠ ∅  →  fail
```

Keep `.bandaid/security-baseline.json` as a list of
`sha256(rule + file + normalized line)` for every accepted finding. Create it
with an explicit, reviewable commit — never silently, and never as a way to make
a failing probe pass.

## S3 — a review of the diff, bounded

A read-only reviewer over `git diff <baseSha>..`, with this scope and no other:

> Review this diff for security defects only. For each finding give the file,
> the line, the class of defect, and **the input that reaches it**. Report only
> defects reachable from untrusted input in this codebase as it is written — not
> defects that would exist if the code were called differently.
>
> In scope: injection (SQL, shell, path, template), authentication and
> authorization gaps, secrets in code or logs, unsafe deserialization, SSRF,
> missing or wrong validation at a trust boundary, TOCTOU, and unbounded
> resource consumption reachable by a request.
>
> Out of scope: style, defence in depth already present elsewhere, theoretical
> issues in code paths no input reaches, and anything you would phrase as
> "consider".
>
> **If you cannot name the input and the path it takes, it is not a finding.**

That last line is doing the same work as the browser rubric's: a security
reviewer without it returns a page of hardening suggestions, none of which are
bugs, and the probe never passes.

## The composite verdict

- exit `1` — S1 found something in the diff, **or** S2 found a new
  high/critical, **or** S3 named a reachable defect;
- exit `78` — all three abstained (no git, no manifest, no reviewer);
- exit `0` — otherwise.

## A secret in the diff is terminal, not another attempt

It is already in the worktree and possibly already pushed. The right response is
telling the user — what it is, where it came from, and that rotating it matters
more than deleting it — not letting the model improvise a remediation and turn
one problem into two. Record it with `bandaid goal block` if the goal cannot
proceed without a replacement credential.

## What this skill does not do

A real audit. It looks at a diff with a handful of patterns and one bounded
review. It will not find a logic flaw in an authorization model, and it is not
evidence that a system is secure — only that this change did not obviously make
it worse.
