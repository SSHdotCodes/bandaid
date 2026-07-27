#!/usr/bin/env node
'use strict';

/**
 * Built-in probe: does the backend still hold under a workload that hurts?
 *
 * The load generator here is deliberately unimpressive. Node 18 ships `fetch`
 * and `AbortController`, which is enough for a fixed-concurrency closed loop
 * with a latency histogram, and shipping that as ~150 lines keeps
 * `"dependencies": {}` intact. Its job is to catch a regression from 2000 rps
 * to 40, not to tell 1900 from 2000. A project that needs the difference names
 * k6 or autocannon in its manifest instead.
 *
 * **The budget has to pre-exist the run.** That single rule is what separates a
 * verifier from a measurement: grading against a number written before the
 * result is what stops "p95 came in at 118ms, which seems fine." No budgets
 * file, no verdict — exit 78 and say so. An unbudgeted load test is telemetry.
 *
 * Exit 0 within budget, 1 on a breach, 78 when it cannot say.
 */

const fs = require('node:fs');
const path = require('node:path');

const ABSTAIN = 78;

function readBudgets(root) {
  for (const rel of ['.bandaid/load-budgets.json', '.bandaid/load.json']) {
    try {
      return { file: rel, budgets: JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) };
    } catch {
      /* try the next */
    }
  }
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

async function warmUp(target, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(target, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One worker, looping until the deadline. Closed-loop rather than open: it
 * measures what the service can do, not what a queue can absorb, which is the
 * question a regression gate is asking.
 */
async function worker(target, deadline, latencies, counters, requestTimeoutMs) {
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(target, { signal: controller.signal });
      // Drain the body: an unread stream keeps the socket busy and flatters the
      // numbers.
      await response.arrayBuffer();
      latencies.push(Date.now() - started);
      if (response.status >= 500 || response.status === 429) counters.errors += 1;
      counters.requests += 1;
    } catch {
      counters.errors += 1;
      counters.requests += 1;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main() {
  const root = process.cwd();
  const found = readBudgets(root);

  if (!found) {
    process.stderr.write(
      'load: no .bandaid/load-budgets.json. A load test graded against no number is telemetry, not a verifier.\n' +
        'Write the budget first, then this probe can fail against it.\n',
    );
    process.exit(ABSTAIN);
  }

  const budgets = found.budgets || {};
  const target = budgets.target;
  if (!target) {
    process.stderr.write(`load: ${found.file} does not name a target URL\n`);
    process.exit(ABSTAIN);
  }

  if (typeof fetch !== 'function') {
    process.stderr.write('load: this Node has no global fetch\n');
    process.exit(ABSTAIN);
  }

  if (!(await warmUp(target))) {
    // A service that is not running has proven nothing about the code, and
    // failing closed here would block every goal in every repository whose
    // server the agent has not started.
    process.stderr.write(`load: ${target} did not answer a warm-up request; is the service running?\n`);
    process.exit(ABSTAIN);
  }

  const concurrency = Number(budgets.concurrency) > 0 ? Number(budgets.concurrency) : 20;
  const durationSec = Number(budgets.durationSec) > 0 ? Number(budgets.durationSec) : 20;
  const requestTimeoutMs = Number(budgets.requestTimeoutMs) > 0 ? Number(budgets.requestTimeoutMs) : 10000;

  const latencies = [];
  const counters = { requests: 0, errors: 0 };
  const rssStart = process.memoryUsage().rss;
  const startedAt = Date.now();
  const deadline = startedAt + durationSec * 1000;

  await Promise.all(
    Array.from({ length: concurrency }, () => worker(target, deadline, latencies, counters, requestTimeoutMs)),
  );

  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    schema: 'bandaid.load/1',
    target,
    concurrency,
    durationSec,
    requests: counters.requests,
    errors: counters.errors,
    errorRate: counters.requests ? counters.errors / counters.requests : 1,
    rps: Number((counters.requests / elapsedSec).toFixed(1)),
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : null,
    },
    rss: { start: rssStart, end: process.memoryUsage().rss },
  };

  const breaches = [];
  const check = (label, actual, limit, over) => {
    if (limit == null || actual == null) return;
    if (over ? actual > limit : actual < limit) breaches.push(`${label} ${actual} ${over ? 'exceeds' : 'is under'} ${limit}`);
  };

  check('error rate', Number(report.errorRate.toFixed(4)), budgets.errorRate, true);
  check('p95', report.latencyMs.p95, budgets.p95Ms, true);
  check('p99', report.latencyMs.p99, budgets.p99Ms, true);
  check('rps', report.rps, budgets.minRps, false);

  report.breaches = breaches;
  report.ok = breaches.length === 0;

  const artifactDir = process.env.BANDAID_ARTIFACT_DIR;
  const artifacts = [];
  if (artifactDir) {
    try {
      fs.writeFileSync(path.join(artifactDir, 'load.json'), `${JSON.stringify(report, null, 2)}\n`);
      artifacts.push(path.join(artifactDir, 'load.json'));
    } catch {
      /* the report still reaches stdout */
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      summary: breaches.length
        ? `${breaches.length} budget breach(es): ${breaches[0]}`
        : `${report.rps} rps, p95 ${report.latencyMs.p95}ms, p99 ${report.latencyMs.p99}ms, ${report.errors} error(s)`,
      findings: breaches.map((message) => ({ severity: 'error', message, pointer: `artifact:${found.file}` })),
      artifacts,
      metrics: { rps: report.rps, p95: report.latencyMs.p95, p99: report.latencyMs.p99, errorRate: report.errorRate },
    })}\n`,
  );

  process.exit(breaches.length ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`load: ${String((err && err.message) || err)}\n`);
  process.exit(1);
});
