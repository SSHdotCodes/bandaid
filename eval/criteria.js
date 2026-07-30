#!/usr/bin/env node
'use strict';

/**
 * Does an independent author write a wider bar than the worker does?
 *
 * `eval/run.js` measures the judge and `eval/loop.js` measures the loop. Neither
 * touches the question brief 12 turns on: acceptance criteria used to be written
 * by the model that would then be graded against them, and the failure that
 * predicts is not a wrong criterion but a *missing* one — a list that is
 * individually reasonable and collectively smaller than the objective. Nothing in
 * the loop can catch that, because from the moment it is recorded the short list
 * IS the bar, for the worker and for the judge alike.
 *
 *   npm run criteria
 *   npm run criteria -- --filter awkward
 *   npm run criteria -- --repeat 3        the derivation is stochastic
 *   npm run criteria -- --json
 *
 * Costs one subprocess model call per fixture per repeat.
 *
 * ## What it cannot measure, stated up front
 *
 * Two weaknesses, both structural, both worth more than the number they qualify:
 *
 * 1. **The worker baseline is recorded, not generated.** A fair comparison would
 *    run a real worker mid-conversation and take the criteria it writes. Instead
 *    each fixture ships a `worker.txt` the fixture author wrote as a best-faith
 *    reconstruction. That is one sample from an imagined distribution, and the
 *    author knew what the harness was going to score. Read the baseline arm as
 *    "a plausible worker list", never as "what workers do".
 * 2. **Coverage is regex over criterion text.** A requirement counts as covered
 *    when one of its patterns matches one criterion. That rewards naming the
 *    right noun, which is a proxy for meaning it. A criterion can match a
 *    requirement while asking for the wrong thing about it.
 *
 * So this harness answers "did the independent author *mention* the awkward half
 * of the objective more often than the recorded worker list does". It does not
 * answer "are these better criteria". The first question is the one that has a
 * cheap honest answer, and it is the one narrowing turns on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const verify = require('../src/lib/verify');

const FIXTURES = path.join(__dirname, 'criteria-fixtures');

function parseArgs(argv) {
  const flags = { filter: null, repeat: 1, json: false, model: 'haiku', timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') flags.json = true;
    else if (argv[i] === '--filter') flags.filter = argv[i + 1];
    else if (argv[i] === '--model') flags.model = argv[i + 1];
    else if (argv[i] === '--repeat') flags.repeat = Number(argv[i + 1]) || 1;
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
  const base = path.join(FIXTURES, dir);
  const objective = readIfPresent(path.join(base, 'objective.txt'));
  if (!objective) return null;

  let requirements;
  try {
    requirements = JSON.parse(readIfPresent(path.join(base, 'requirements.json')));
  } catch {
    return null;
  }
  if (!Array.isArray(requirements) || !requirements.length) return null;

  return {
    name: dir,
    objective,
    requirements,
    worker: readIfPresent(path.join(base, 'worker.txt'))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    repo: path.join(base, 'repo'),
    note: readIfPresent(path.join(base, 'note.txt')),
  };
}

/**
 * Which ground-truth requirements this list of criteria reaches.
 *
 * Deliberately generous: any pattern matching any criterion counts the whole
 * requirement covered. A strict matcher would make the harness measure phrasing,
 * and the thing under test is whether the requirement was *thought about* at all.
 */
function cover(criteria, requirements) {
  const text = criteria.join('\n');
  const covered = [];
  const missed = [];
  for (const req of requirements) {
    const hit = (req.match || []).some((pattern) => new RegExp(pattern, 'i').test(text));
    (hit ? covered : missed).push(req.id);
  }
  return { covered, missed, score: requirements.length ? covered.length / requirements.length : 0 };
}

/** The derivation reads a repository, so each sample gets a disposable copy. */
function derive(fixture, flags) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bandaid-criteria-${fixture.name}-`));
  try {
    if (fs.existsSync(fixture.repo)) fs.cpSync(fixture.repo, tmp, { recursive: true });
    return verify.runCriteria({
      objective: fixture.objective,
      cwd: tmp,
      model: flags.model,
      timeoutMs: flags.timeoutMs,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function pct(n) {
  return `${Math.round(n * 100)}%`;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));

  let dirs;
  try {
    dirs = fs.readdirSync(FIXTURES).filter((d) => fs.statSync(path.join(FIXTURES, d)).isDirectory());
  } catch {
    console.log('\n  eval/criteria: no fixtures found.\n');
    return;
  }
  if (flags.filter) dirs = dirs.filter((d) => d.includes(flags.filter));

  const results = [];
  for (const dir of dirs.sort()) {
    const fixture = loadFixture(dir);
    if (!fixture) continue;

    const baseline = cover(fixture.worker, fixture.requirements);
    const samples = [];
    for (let i = 0; i < flags.repeat; i += 1) {
      const derived = derive(fixture, flags);
      // An abstention is not a zero. The CLI falls back to the worker list when
      // this happens, so scoring it as total failure would misreport the
      // mechanism as worse than the thing it degrades to.
      samples.push(derived && derived.length ? { criteria: derived, ...cover(derived, fixture.requirements) } : null);
    }

    const scored = samples.filter(Boolean);
    results.push({
      name: fixture.name,
      requirements: fixture.requirements.length,
      baseline,
      samples,
      abstained: samples.length - scored.length,
      independent: scored.length ? scored.reduce((sum, s) => sum + s.score, 0) / scored.length : null,
      note: fixture.note,
    });
  }

  if (flags.json) {
    console.log(JSON.stringify({ repeat: flags.repeat, results }, null, 2));
    return;
  }

  console.log('');
  console.log(`  fixtures   ${results.length}   ·   samples per fixture   ${flags.repeat}`);
  console.log('');
  console.log(`  ${'fixture'.padEnd(18)} ${'reqs'.padEnd(5)} ${'worker'.padEnd(8)} ${'independent'.padEnd(12)} missed by worker`);

  for (const r of results) {
    const ind = r.independent == null ? 'abstained' : pct(r.independent);
    console.log(
      `  ${r.name.padEnd(18)} ${String(r.requirements).padEnd(5)} ${pct(r.baseline.score).padEnd(8)} ${ind.padEnd(12)} ${r.baseline.missed.join(', ') || '-'}`,
    );
  }

  const scoreable = results.filter((r) => r.independent != null);
  const workerMean = results.length ? results.reduce((s, r) => s + r.baseline.score, 0) / results.length : 0;
  const indMean = scoreable.length ? scoreable.reduce((s, r) => s + r.independent, 0) / scoreable.length : null;
  const abstentions = results.reduce((s, r) => s + r.abstained, 0);

  console.log('');
  console.log(`  worker       ${pct(workerMean)} of ground-truth requirements covered`);
  console.log(`  independent  ${indMean == null ? 'nothing scoreable' : `${pct(indMean)} of ground-truth requirements covered`}`);
  if (abstentions) console.log(`  abstained    ${abstentions} sample(s) — the CLI falls back to the worker list here`);

  // The deletion condition, stated in advance so that meeting it is a result
  // rather than a defeat. README.md:849-851 is the standing rule.
  console.log('');
  if (indMean == null) {
    console.log('  VERDICT    not scoreable. Nothing was derived, so this run says nothing either way.');
  } else if (indMean > workerMean) {
    console.log(`  VERDICT    independent derivation covers ${pct(indMean - workerMean)} more of the bar. It earns its subprocess.`);
  } else if (indMean === workerMean) {
    console.log('  VERDICT    no difference on this suite. Per README.md:849-851 that is an argument for deleting it,');
    console.log('             weighed against the caveats at the top of this file — the baseline is one authored sample.');
  } else {
    console.log(`  VERDICT    independent derivation covers ${pct(workerMean - indMean)} LESS. That is a result against the mechanism.`);
  }
  console.log('');
}

main();
