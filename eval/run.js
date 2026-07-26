#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const verify = require('../src/lib/verify');

/**
 * Does the grader actually grade?
 *
 * Bandaid's whole case rests on a verifier that outranks the model's own
 * opinion. That is only an improvement if the verifier is right, and nothing
 * else in this repo measures whether it is. The fixtures here are built around
 * the failure that matters: work that *looks* finished. A judge that returns
 * "complete" on a stubbed test is worse than no judge, because it launders a
 * model's self-assessment as an independent one.
 *
 *   npm run eval                 all fixtures, once each
 *   npm run eval -- --repeat 3   three samples per fixture; the judge is stochastic
 *   npm run eval -- --filter stub
 *
 * Costs one subprocess model call per fixture per repeat.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [key, inline] = argv[i].slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[(i += 1)];
    else flags[key] = true;
  }
  return flags;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadFixture(dir) {
  const objective = readIfPresent(path.join(dir, 'objective.txt'));
  const expected = readIfPresent(path.join(dir, 'expected')).toLowerCase();
  if (!objective || !['complete', 'continue'].includes(expected)) return null;

  const criteria = readIfPresent(path.join(dir, 'criteria.txt'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const checkFile = path.join(dir, 'check.sh');
  return {
    name: path.basename(dir),
    objective,
    criteria,
    expected,
    check: fs.existsSync(checkFile) ? `sh "${checkFile}"` : null,
    repo: path.join(dir, 'repo'),
    note: readIfPresent(path.join(dir, 'note.txt')),
  };
}

/** The judge inspects a worktree, so each run gets its own disposable copy. */
function runFixture(fixture, { model, timeoutMs }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bandaid-eval-${fixture.name}-`));
  try {
    fs.cpSync(fixture.repo, tmp, { recursive: true });
    const assessment = verify.assess({
      goal: { objective: fixture.objective, criteria: fixture.criteria, check: fixture.check },
      config: { goals: { judge: true, judgeModel: model, verifyTimeoutMs: timeoutMs } },
      cwd: tmp,
      // Deliberately empty: the judge has to work from the repository, not from
      // a log of what the engineer says it did.
      turns: [],
    });
    return { verdict: assessment.proven ? 'complete' : 'continue', reason: assessment.reason };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const model = typeof flags.model === 'string' ? flags.model : 'haiku';
  const repeat = Number.parseInt(flags.repeat, 10) > 0 ? Number.parseInt(flags.repeat, 10) : 1;
  const timeoutMs = Number.parseInt(flags.timeout, 10) > 0 ? Number.parseInt(flags.timeout, 10) : 180000;

  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stdout.write('eval: the `claude` CLI is not available; skipping.\n');
    return;
  }

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(FIXTURES, entry.name))
      .sort();
  } catch {
    process.stderr.write(`eval: no fixtures at ${FIXTURES}\n`);
    process.exitCode = 1;
    return;
  }

  const fixtures = dirs
    .map(loadFixture)
    .filter(Boolean)
    .filter((f) => (typeof flags.filter === 'string' ? f.name.includes(flags.filter) : true));

  if (!fixtures.length) {
    process.stderr.write('eval: no fixtures matched\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`eval: ${fixtures.length} fixture(s), model ${model}, ${repeat} run(s) each\n\n`);

  // Positive class is "complete": calling unfinished work done is the expensive
  // error, so that is the one the matrix is oriented around.
  const matrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const rows = [];

  for (const fixture of fixtures) {
    for (let i = 0; i < repeat; i += 1) {
      const { verdict, reason } = runFixture(fixture, { model, timeoutMs });
      const ok = verdict === fixture.expected;
      if (verdict === 'complete') matrix[fixture.expected === 'complete' ? 'tp' : 'fp'] += 1;
      else matrix[fixture.expected === 'continue' ? 'tn' : 'fn'] += 1;

      rows.push({ name: fixture.name, run: i + 1, expected: fixture.expected, verdict, ok, reason, note: fixture.note });
      process.stdout.write(
        `  ${ok ? 'PASS' : 'FAIL'}  ${fixture.name}${repeat > 1 ? ` #${i + 1}` : ''}  expected ${fixture.expected}, got ${verdict}\n` +
          (reason ? `          reason: ${reason}\n` : ''),
      );
    }
  }

  const total = rows.length;
  const correct = rows.filter((r) => r.ok).length;
  const precision = matrix.tp + matrix.fp ? matrix.tp / (matrix.tp + matrix.fp) : null;
  const recall = matrix.tp + matrix.fn ? matrix.tp / (matrix.tp + matrix.fn) : null;
  const pct = (n) => (n == null ? 'n/a' : `${(n * 100).toFixed(0)}%`);

  process.stdout.write('\n');
  process.stdout.write(`  accuracy   ${correct}/${total} (${pct(correct / total)})\n`);
  process.stdout.write(`  confusion  complete-when-complete ${matrix.tp}   complete-when-not ${matrix.fp}\n`);
  process.stdout.write(`             continue-when-not      ${matrix.tn}   continue-when-complete ${matrix.fn}\n`);
  process.stdout.write(`  precision  ${pct(precision)}  (of the goals it closed, how many were really done)\n`);
  process.stdout.write(`  recall     ${pct(recall)}  (of the goals really done, how many it closed)\n`);

  if (matrix.fp) {
    process.stdout.write(`\n  ${matrix.fp} false close(s) — the failure mode that matters:\n`);
    for (const row of rows.filter((r) => !r.ok && r.verdict === 'complete')) {
      process.stdout.write(`    ${row.name}${row.note ? ` — ${row.note}` : ''}\n`);
    }
  }

  if (flags.json) process.stdout.write(`\n${JSON.stringify({ rows, matrix, correct, total }, null, 2)}\n`);
  if (correct !== total) process.exitCode = 1;
}

main();
