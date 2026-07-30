'use strict';

/**
 * The loop harness itself.
 *
 * eval/run.js's header states the reason this file exists: "a judge that returns
 * 'complete' on a stubbed test is worse than no judge, because it launders a
 * model's self-assessment as an independent one." The same is true one level up. A
 * broken harness produces confident wrong numbers, and this one already did once —
 * its first version reported a MAPE-style figure from an unfinished session and its
 * `ended by` row mislabelled which mechanism stopped a loop.
 *
 * So: does it actually release when it should, does it fail loudly rather than
 * quietly, does it clean up after itself, and — the one that keeps every ablation
 * number honest — does `--ablate` really withhold the block it names?
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { after, describe, it } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const LOOP = path.join(ROOT, 'eval', 'loop.js');
const FIXTURES = path.join(ROOT, 'eval', 'loop-fixtures');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function runLoop(args) {
  const out = execFileSync(process.execPath, [LOOP, ...args, '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
    stdio: 'pipe',
    // Generous: each fixture spawns several subprocesses per round.
    timeout: 180_000,
  });
  return JSON.parse(out);
}

/** A throwaway fixture written into the real fixtures dir, removed afterwards. */
function fixture(name, files) {
  const dir = path.join(FIXTURES, name);
  scratch.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return name;
}

describe('the shipped fixtures', () => {
  it('has a rounds script and an expectation for every one of them', () => {
    // A fixture with no expectation is graded against nothing and always passes,
    // which is how a suite quietly stops measuring.
    const dirs = fs
      .readdirSync(FIXTURES)
      .filter((d) => fs.statSync(path.join(FIXTURES, d)).isDirectory())
      .filter((d) => !d.startsWith('zz-'));

    assert.ok(dirs.length >= 6, `expected the six-plus shipped fixtures, found ${dirs.length}`);
    for (const dir of dirs) {
      assert.ok(fs.existsSync(path.join(FIXTURES, dir, 'objective.txt')), `${dir} has no objective`);
      const expected = path.join(FIXTURES, dir, 'expected.json');
      assert.ok(fs.existsSync(expected), `${dir} has no expected.json`);
      const want = JSON.parse(fs.readFileSync(expected, 'utf8'));
      assert.ok(
        want.releases != null || want.status != null || want.notStatus != null,
        `${dir}'s expectation asserts nothing`,
      );
    }
  });
});

describe('releasing', () => {
  it('releases at round 1 when the check already passes', () => {
    const name = fixture('zz-instant', {
      'objective.txt': 'Do the thing that is already done\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'exit 0\n',
      'rounds/01.sh': 'true\n',
      'expected.json': '{"releases":true,"byRound":1,"status":"complete"}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '3']);
    const [result] = results;
    assert.equal(result.released, true);
    assert.equal(result.rounds, 1);
    assert.equal(result.status, 'complete');
    assert.equal(result.endedBy, 'check');
  });

  it('reports hitting the round cap as truncation, not as a release', () => {
    const name = fixture('zz-forever', {
      'objective.txt': 'Chase something unreachable\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      // Output changes every round, so nothing converges and nothing repeats.
      'check.sh': 'echo "still $(cat src/n.txt 2>/dev/null | wc -c)"\nexit 1\n',
      'rounds/01.sh': 'echo x >> src/n.txt\n',
      'rounds/02.sh': 'echo xx >> src/n.txt\n',
      'expected.json': '{"notStatus":"complete"}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '2']);
    const [result] = results;
    assert.equal(result.released, false);
    assert.equal(result.endedBy, 'rounds-exhausted');
    assert.notEqual(result.status, 'complete');
  });
});

describe('failing loudly', () => {
  it('fails the fixture when a round script errors, rather than reading it as no change', () => {
    const name = fixture('zz-broken-round', {
      'objective.txt': 'Never mind\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'rounds/01.sh': 'exit 3\n',
      'expected.json': '{"releases":false}',
    });

    const { results } = runLoop(['--filter', name, '--rounds', '2']);
    const [result] = results;
    assert.ok(result.error, 'a round that could not run must not be silently skipped');
    assert.match(result.error, /exited 3/);
  });

  it('leaves no temporary directory behind, even when a round fails', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('bandaid-loop-'));
    runLoop(['--filter', 'zz-broken-round', '--rounds', '2']);
    const after = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('bandaid-loop-'));
    assert.deepEqual(after, before, 'the sandbox is removed in a finally block for this reason');
  });
});

describe('ablation', () => {
  it('genuinely withholds the block it names, which is what keeps the numbers honest', () => {
    // Measured through the recorded prompt length: withholding the 277-word
    // completion audit has to make the prompt materially shorter. An --ablate flag
    // that silently did nothing would report "no effect" for every block.
    const name = fixture('zz-ablate', {
      'objective.txt': 'Something that will not finish this round\n',
      'criteria.txt': 'the check exits 0\n',
      'repo/src/x.js': 'module.exports = {};\n',
      'check.sh': 'echo "not yet"\nexit 1\n',
      'rounds/01.sh': 'true\n',
      'expected.json': '{"notStatus":"complete"}',
    });

    const full = runLoop(['--filter', name, '--rounds', '1']).results[0].log[0].stderrWords;
    const cut = runLoop(['--filter', name, '--rounds', '1', '--ablate', 'completion-audit']).results[0].log[0]
      .stderrWords;

    assert.ok(full > 0, 'the unablated round produced a prompt');
    assert.ok(
      full - cut > 200,
      `withholding the completion audit changed the prompt by only ${full - cut} words; it is ~277`,
    );
  });
});
