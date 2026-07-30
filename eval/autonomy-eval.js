#!/usr/bin/env node
'use strict';

/**
 * Precision on the allow class, which is the only number that decides this.
 *
 * Blocking a genuine question traps the user in a loop where the question is never
 * asked. Allowing a permission-ask costs one early turn and a typed "continue". So
 * the gate is: **of the stops let through, how many were really genuine** — and it
 * has to be 100%, because there is no threshold argument that makes locking a user
 * out acceptable when the fallback is that cheap.
 *
 * Recall is reported and is not the gate. A classifier that catches half the
 * permission-asks and never traps the user is a real improvement; one that catches
 * all of them and traps the user occasionally is not.
 *
 *   node eval/autonomy-eval.js
 *   node eval/autonomy-eval.js --json
 */

const fs = require('node:fs');
const path = require('node:path');

const { classifyTrailingQuestion } = require('../src/lib/autonomy');

const CORPUS = path.join(__dirname, 'autonomy-fixtures', 'questions.jsonl');

function main() {
  const json = process.argv.includes('--json');

  const cases = fs
    .readFileSync(CORPUS, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const rows = cases.map((c) => {
    const verdict = classifyTrailingQuestion(c.text, { blockers: c.blockers || [] });
    // 'unknown' allows the stop, so for scoring it counts as an allow.
    const action = verdict.kind === 'permission' ? 'block' : 'allow';
    return { ...c, kind: verdict.kind, action };
  });

  const genuine = rows.filter((r) => r.expect === 'genuine');
  const permission = rows.filter((r) => r.expect === 'permission');

  // The two errors are not symmetric, so they do not share a metric.
  //
  // Blocking a genuine question is the trap: the user is locked out of a
  // conversation they are needed in. That is the gate, and it must be zero.
  //
  // Allowing a permission-ask is the *status quo* — one turn ends early and the
  // user types "continue". It is reported as recall and gates nothing, because a
  // classifier that catches half of them and never traps the user is strictly
  // better than today, while one that catches all of them and traps the user
  // sometimes is not.
  const wronglyBlocked = rows.filter((r) => r.action === 'block' && r.expect === 'genuine');
  const genuineAllowed = genuine.length - wronglyBlocked.length;
  const genuineSafe = genuine.length ? Math.round((genuineAllowed / genuine.length) * 100) : 100;
  const blockRecall = permission.length
    ? Math.round((permission.filter((r) => r.action === 'block').length / permission.length) * 100)
    : 0;
  const unknown = rows.filter((r) => r.kind === 'unknown');

  if (json) {
    console.log(JSON.stringify({ genuineSafe, blockRecall, wronglyBlocked: wronglyBlocked.length, rows }, null, 2));
    return;
  }

  console.log('');
  console.log(`  corpus     ${rows.length} cases (${permission.length} permission, ${genuine.length} genuine)`);
  console.log(`  GATE       genuine questions still allowed ${genuineAllowed}/${genuine.length} (${genuineSafe}%)`);
  console.log(`  recall     permission-asks caught ${permission.filter((r) => r.action === 'block').length}/${permission.length} (${blockRecall}%)  — not the gate`);
  console.log(`  unknown    ${unknown.length} case(s) matched nothing and fell through to allow`);

  if (wronglyBlocked.length) {
    console.log('');
    console.log('  BLOCKED A GENUINE QUESTION — this is the failure that traps the user:');
    for (const row of wronglyBlocked) console.log(`    ${JSON.stringify(row.text)}  (${row.note})`);
  }

  const missed = permission.filter((r) => r.action === 'allow');
  if (missed.length) {
    console.log('');
    console.log('  missed (allowed a permission-ask — costs one turn, the old behaviour):');
    for (const row of missed) console.log(`    ${JSON.stringify(row.text)}  (${row.note})`);
  }

  console.log('');
  // Only the trap fails this. Missed permission-asks are the status quo.
  if (wronglyBlocked.length) process.exitCode = 1;
}

main();
