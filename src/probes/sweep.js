#!/usr/bin/env node
'use strict';

/**
 * Built-in probe: confirm a sweep's findings by running their reproductions.
 *
 * There is no exit code for "are there bugs", so this does not invent one.
 * Instead every finding must ship a command expected to fail *right now*, and
 * the runtime runs it. `reproExit !== 0` is a confirmed bug; `=== 0` is
 * discarded as unreproducible.
 *
 * That execution step is the whole point. It is the hallucination filter that
 * makes a fan-out of read-only agents safe to trust, and it is Karpathy's
 * fourth principle aimed at bugs nobody had found yet: turn "there is a bug
 * over there" into "here is a command that fails, now make it pass."
 *
 * The agents propose; only this file touches a shell. A finding cannot mark
 * itself confirmed, the same asymmetry that stops the model writing `supported`
 * into the evidence ledger.
 *
 * Exit 0 when nothing is confirmed, 1 when something is, 78 with no report.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ABSTAIN = 78;

/**
 * ponytail: repros run in the working directory with a 60s ceiling and Bandaid
 * disarmed, not in a sandbox. A repro that writes outside the repository, hits
 * the network, or installs something escapes that — the skill says not to write
 * one, and nothing enforces it. The upgrade path is a container, which is a
 * dependency, which is out of scope. A throwaway git worktree was considered
 * and rejected: it would check out committed state and so test the wrong code,
 * since a sweep is about defects present *now*.
 */
const REPRO_TIMEOUT_MS = 60000;

function reportPath() {
  return process.env.BANDAID_ARTIFACT_DIR
    ? path.join(process.env.BANDAID_ARTIFACT_DIR, 'findings.json')
    : path.join('.bandaid', 'artifacts', 'sweep', 'findings.json');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Entries carry a required reason, so dismissing a finding is a decision on record. */
function allowed(root) {
  const list = readJson(path.join(root, '.bandaid', 'sweep-allow.json'), []) || [];
  const ids = new Set();
  const pointers = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || !entry.reason) continue;
    if (entry.id) ids.add(String(entry.id));
    if (entry.pointer) pointers.add(String(entry.pointer));
  }
  return { ids, pointers };
}

function runRepro(finding, root) {
  const repro = finding.repro || {};
  const command = repro.command || (repro.testFile ? `npm test -- ${JSON.stringify(repro.testFile)}` : null);
  if (!command) return { status: 'discarded-no-repro', exit: null };

  const result = spawnSync(command, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    timeout: REPRO_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    // A repro must never recurse into the thing that is running it.
    env: { ...process.env, BANDAID_ENABLED: '0' },
  });

  if (result.error) {
    // A repro that cannot run has not demonstrated a bug. Saying so is more
    // useful than either confirming or silently dropping it.
    return { status: 'discarded-unrunnable', exit: null, detail: String(result.error.message || result.error) };
  }

  return {
    status: result.status === 0 ? 'discarded-unreproducible' : 'confirmed',
    exit: result.status,
    detail: String(result.stderr || result.stdout || '').trim().slice(-500),
  };
}

function main() {
  const root = process.cwd();
  const file = reportPath();
  const report = readJson(file);

  if (!report || !Array.isArray(report.findings)) {
    process.stderr.write(`sweep: no findings at ${file}. Run the bandaid-sweep skill with a seed to produce some.\n`);
    process.exit(ABSTAIN);
  }

  const stamp = process.env.BANDAID_STAMP || '';
  if (stamp && report.stamp && report.stamp !== stamp) {
    process.stderr.write('sweep: the findings describe an earlier state of the worktree; re-run the skill.\n');
    process.exit(ABSTAIN);
  }

  if (!report.findings.length) {
    process.stdout.write(`${JSON.stringify({ summary: 'nothing found', findings: [], metrics: { confirmed: 0 } })}\n`);
    process.exit(0);
  }

  const allow = allowed(root);
  const graded = [];

  for (const finding of report.findings) {
    const result = runRepro(finding, root);
    const dismissed = allow.ids.has(String(finding.id)) || allow.pointers.has(String(finding.pointer));
    graded.push({
      ...finding,
      reproExit: result.exit,
      status: dismissed && result.status === 'confirmed' ? 'dismissed' : result.status,
      reproDetail: result.detail || null,
    });
  }

  // Write the graded version back, so the statuses the runtime set are what a
  // reader sees rather than the ones the agents proposed.
  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...report, findings: graded }, null, 2)}\n`);
  } catch {
    /* stdout still carries the verdict */
  }

  const confirmed = graded.filter((f) => f.status === 'confirmed');
  const discarded = graded.filter((f) => String(f.status).startsWith('discarded'));

  process.stdout.write(
    `${JSON.stringify({
      summary: confirmed.length
        ? `${confirmed.length} confirmed bug(s), ${discarded.length} discarded as unreproducible: ${confirmed[0].title}`
        : `nothing confirmed (${discarded.length} finding(s) did not reproduce)`,
      findings: confirmed.map((f) => ({
        severity: 'error',
        message: `${f.title} — ${f.pointer || 'no pointer'}`,
        pointer: f.pointer || null,
      })),
      artifacts: [file],
      metrics: { proposed: graded.length, confirmed: confirmed.length, discarded: discarded.length },
    })}\n`,
  );

  process.exit(confirmed.length ? 1 : 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`sweep: ${String((err && err.message) || err)}\n`);
  process.exit(1);
}
