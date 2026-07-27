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
 *   npm run eval                       all fixtures, once each
 *   npm run eval -- --repeat 3         three samples per fixture; the judge is stochastic
 *   npm run eval -- --filter stub
 *   npm run eval -- --ablate ledger    withhold one block and see whether accuracy moves
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
  if (!objective || !['complete', 'continue', 'violated'].includes(expected)) return null;

  const lines = (file) =>
    readIfPresent(path.join(dir, file))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const checkFile = path.join(dir, 'check.sh');
  const evidenceFile = path.join(dir, 'evidence.jsonl');
  return {
    name: path.basename(dir),
    objective,
    criteria: lines('criteria.txt'),
    // The two things that change what the judge is being asked. Optional, so
    // every fixture that predates them loads unchanged.
    constraints: lines('constraints.txt'),
    blockers: lines('blockers.txt'),
    // A ledger the judge will be shown. The point of these fixtures is that a
    // ledger entry is a lead, never a finding: a fixture whose ledger claims
    // the work is done, over a repository where it is not, must still continue.
    evidence: fs.existsSync(evidenceFile) ? readIfPresent(evidenceFile) : null,
    expected,
    check: fs.existsSync(checkFile) ? `sh "${checkFile}"` : null,
    repo: path.join(dir, 'repo'),
    note: readIfPresent(path.join(dir, 'note.txt')),
  };
}

/**
 * Which parts of the judge's prompt to withhold for this run.
 *
 * The question nobody could answer before: does each block earn its tokens?
 * A mechanism whose ablation moves no number should be deleted, and saying so
 * in advance is what makes deleting it a result rather than a defeat.
 *
 * `completion-audit` is deliberately absent. It lives in the continuation
 * prompt, which the judge never sees, so this harness cannot measure it — an
 * honest limitation rather than a gap to paper over.
 */
const ABLATABLE = new Set(['criteria', 'constraints', 'blockers', 'ledger']);

function applyAblation(fixture, ablate) {
  if (!ablate) return fixture;
  return {
    ...fixture,
    criteria: ablate === 'criteria' ? [] : fixture.criteria,
    constraints: ablate === 'constraints' ? [] : fixture.constraints,
    blockers: ablate === 'blockers' ? [] : fixture.blockers,
    evidence: ablate === 'ledger' ? null : fixture.evidence,
  };
}

/** The judge inspects a worktree, so each run gets its own disposable copy. */
function runFixture(fixture, { model, timeoutMs }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bandaid-eval-${fixture.name}-`));
  // A ledger lives beside the project, not inside the repository, so a fixture
  // that seeds one needs its own state dir. Restored afterwards so fixtures
  // cannot leak into each other or into the developer's real state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `bandaid-eval-home-${fixture.name}-`));
  const previousHome = process.env.BANDAID_HOME;

  try {
    fs.cpSync(fixture.repo, tmp, { recursive: true });

    const goal = {
      objective: fixture.objective,
      criteria: fixture.criteria,
      constraints: fixture.constraints,
      blockers: fixture.blockers,
      check: fixture.check,
    };

    if (fixture.evidence) {
      process.env.BANDAID_HOME = home;
      // Requiring these late keeps `BANDAID_HOME` honest: both resolve it at
      // call time, but the intent is clearer than relying on that.
      const project = require('../src/lib/project');
      const evidenceLib = require('../src/lib/evidence');
      goal.projectRoot = tmp;

      const hash = evidenceLib.objectiveHash(fixture.objective);
      const stamp = require('../src/lib/stamp').worktreeStamp(tmp);
      const seeded = fixture.evidence
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const record = JSON.parse(line);
          // Fixtures declare freshness as a word rather than a hash they cannot
          // know: "fresh" means "describes this worktree".
          const fresh = record.stamp !== 'stale';
          return JSON.stringify({ ...record, objectiveHash: hash, stamp: fresh ? stamp.fp : 'an-earlier-worktree' });
        });

      fs.mkdirSync(project.projectDir(tmp), { recursive: true });
      fs.writeFileSync(evidenceLib.evidenceFile(tmp), `${seeded.join('\n')}\n`);
    }

    const assessment = verify.assess({
      goal,
      config: { goals: { judge: true, judgeModel: model, verifyTimeoutMs: timeoutMs } },
      cwd: tmp,
      // Deliberately empty: the judge has to work from the repository, not from
      // a log of what the engineer says it did.
      turns: [],
      record: Boolean(fixture.evidence),
    });
    const verdict = assessment.violated ? 'violated' : assessment.proven ? 'complete' : 'continue';
    return { verdict, reason: assessment.reason };
  } finally {
    if (previousHome === undefined) delete process.env.BANDAID_HOME;
    else process.env.BANDAID_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const model = typeof flags.model === 'string' ? flags.model : 'haiku';
  const repeat = Number.parseInt(flags.repeat, 10) > 0 ? Number.parseInt(flags.repeat, 10) : 1;
  const timeoutMs = Number.parseInt(flags.timeout, 10) > 0 ? Number.parseInt(flags.timeout, 10) : 180000;

  const ablate = typeof flags.ablate === 'string' ? flags.ablate : null;
  if (ablate && !ABLATABLE.has(ablate)) {
    process.stderr.write(`eval: --ablate takes one of ${[...ABLATABLE].join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

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

  process.stdout.write(
    `eval: ${fixtures.length} fixture(s), model ${model}, ${repeat} run(s) each${ablate ? `, WITHOUT ${ablate}` : ''}\n\n`,
  );

  // Positive class is "complete": calling unfinished work done is the expensive
  // error, so that is the one the matrix is oriented around.
  const matrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const rows = [];

  for (const fixture of fixtures) {
    for (let i = 0; i < repeat; i += 1) {
      const { verdict, reason } = runFixture(applyAblation(fixture, ablate), { model, timeoutMs });
      const ok = verdict === fixture.expected;
      if (verdict === 'complete') matrix[fixture.expected === 'complete' ? 'tp' : 'fp'] += 1;
      // Anything that is not "complete" left the goal open, which is the right
      // call for both "continue" and "violated".
      else matrix[fixture.expected === 'complete' ? 'fn' : 'tn'] += 1;

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

  if (ablate) {
    process.stdout.write(
      `\n  This run withheld \`${ablate}\` from the judge. Compare with a plain run:\n` +
        '  a mechanism whose ablation moves no number is a mechanism to delete.\n',
    );
  }

  if (flags.json) process.stdout.write(`\n${JSON.stringify({ rows, matrix, correct, total, ablate }, null, 2)}\n`);
  if (correct !== total) process.exitCode = 1;
}

main();
