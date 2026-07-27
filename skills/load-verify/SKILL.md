---
name: bandaid-load-verify
description: >
  Put a backend under sustained load and grade the result against a budget written
  beforehand. Use when a Bandaid load probe abstains for want of a budgets file, when a
  goal's criteria mention throughput, latency, p95/p99, concurrency, or holding up under
  load, or when a change touches a request path and the user wants to know it still
  performs. Produces .bandaid/load-budgets.json and, on a run, a latency report the probe
  grades by exit code. Not for microbenchmarks and not for capacity planning.
---

# Load verification

## The one rule

**The budget has to exist before the measurement does.**

That is what separates a verifier from telemetry. Grading against a number
written *before* the run is what stops "p95 came in at 118ms, which seems fine."
A threshold you set after seeing the result is not a threshold.

So the probe abstains — loudly — when there is no `.bandaid/load-budgets.json`.
Writing that file is the main thing this skill is for.

## 1. Write the budget

`.bandaid/load-budgets.json`, committed:

```json
{
  "target": "http://localhost:3000/api/search",
  "concurrency": 50,
  "durationSec": 60,
  "p95Ms": 150,
  "p99Ms": 400,
  "errorRate": 0.001,
  "minRps": 300
}
```

Every threshold is optional; the ones you omit are not graded. Choosing them:

- **Do not invent numbers.** If the project has an SLO, a dashboard, or a
  previous benchmark, use it and say where it came from in the commit.
- **If there is no prior number**, measure the current behaviour first, then set
  the budget at roughly 1.5× the observed p95 and 0.7× the observed rps. That
  makes it a *regression* gate, which is the honest thing it can be on day one.
  Say so in the file's commit message.
- **Ask the user rather than guessing** when the number would be load-bearing —
  a latency budget on a checkout path is a product decision, not a technical
  one.

A budget the model can edit after seeing the result is not a budget. This file
is committed and reviewable precisely so that changing it is a visible act.

## 2. Pick a generator

In this order:

1. **The project's own**, if `k6`, `autocannon`, `wrk`, `vegeta`, or `ab` is on
   `PATH` or in `devDependencies`. Point the manifest's `run` at it and have it
   emit the report shape below.
2. **Bandaid's built-in**, which needs nothing installed:

```json
// .bandaid/probes.json
{ "probes": [
  { "id": "load", "builtin": "load",
    "when": { "changed": ["src/api/**", "src/server/**"] },
    "timeoutMs": 180000 }
] }
```

The built-in is deliberately unimpressive: fixed-concurrency closed loop,
`fetch`, a latency histogram. It catches a regression from 2000 rps to 40. It
will not tell 1900 from 2000. If you need that difference, use k6.

## 3. Start the service yourself

The probe does **not** start servers. It is launched detached by a hook, and a
hook that spawns a server orphans processes and collides on ports. Start it in
this session, where the user can see it and kill it.

If the target does not answer a warm-up request, the probe abstains rather than
failing — a service that is not running has proven nothing about the code, and
failing there would block every goal in every repo whose server nobody started.

## 4. Read the result

```
2140 rps, p95 61ms, p99 143ms, 0 error(s)
```

or

```
2 budget breach(es): p99 890 exceeds 400
```

`breaches[]` is what reaches the model, and it is phrased to be actionable.
"p99 890 exceeds 400" tells you what to look at; "load test failed" does not.

## Reading a failure

- **p99 breached, p50 fine** — a tail problem: a lock, a cold cache path, a
  connection pool at its limit. Look at what only some requests do.
- **error rate breached under load, zero at rest** — usually a pool, a file
  descriptor limit, or a downstream timing out.
- **rps collapsed** — something became synchronous. Compare against the diff
  rather than the code as a whole.
- **everything breached** — check the target is the endpoint you meant. A 404
  is fast and useless.

## What this skill does not do

Capacity planning, cost modelling, or distributed load. One generator on one
machine measures a regression, not a production ceiling — and pretending
otherwise is how a number gets quoted in a meeting it cannot support.
