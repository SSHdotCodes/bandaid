'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

/**
 * End-to-end hook contract.
 *
 * These run the real hook scripts the way Claude Code runs them — JSON on
 * stdin, meaning carried by the exit code — against a throwaway state dir.
 * They are the tests that would catch a change breaking the integration.
 */

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-e2e-'));
const SESSION = 'e2e-session-0001';

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function runHook(script, input, extraEnv = {}) {
  const file = path.join(ROOT, 'src', 'hooks', script);
  const result = { code: 0, stdout: '', stderr: '' };
  try {
    result.stdout = execFileSync(process.execPath, [file], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, BANDAID_HOME: HOME, BANDAID_CONFIG: path.join(HOME, 'config.json'), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    result.code = err.status ?? 1;
    result.stdout = err.stdout || '';
    result.stderr = err.stderr || '';
  }
  return result;
}

function cli(args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'bin', 'bandaid.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, BANDAID_HOME: HOME, BANDAID_CONFIG: path.join(HOME, 'config.json') },
  });
}

const PROMPT_ONE = 'Port the tokenizer to Rust. Do not add any dependencies.';
const PROMPT_TWO = 'Now make the tests pass.';

describe('hook lifecycle', () => {
  it('UserPromptSubmit records the prompt and stays silent', () => {
    const result = runHook('user-prompt-submit.js', {
      session_id: SESSION,
      cwd: ROOT,
      prompt: PROMPT_ONE,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '', 'must cost zero tokens on the happy path');

    const ledger = fs.readFileSync(path.join(HOME, 'sessions', SESSION, 'prompts.jsonl'), 'utf8');
    assert.ok(ledger.includes(PROMPT_ONE));
  });

  it('PostToolBatch records call arguments and results', () => {
    const result = runHook('post-tool-batch.js', {
      session_id: SESSION,
      cwd: ROOT,
      tool_calls: [
        {
          tool_name: 'Edit',
          tool_input: { file_path: '/repo/src/tokenizer.rs', old_string: 'fn old()' },
          tool_response: 'Applied 1 edit',
        },
        {
          tool_name: 'Bash',
          tool_input: { command: 'cargo test', description: 'run the suite' },
          tool_response: 'test result: FAILED. 2 passed; 1 failed',
        },
      ],
    });
    assert.equal(result.code, 0);

    const turns = fs.readFileSync(path.join(HOME, 'sessions', SESSION, 'turns.jsonl'), 'utf8');
    assert.ok(turns.includes('/repo/src/tokenizer.rs'));
    assert.ok(turns.includes('cargo test'));
    assert.ok(turns.includes('2 passed; 1 failed'));
  });

  it('PreCompact replaces the summarization directive with Codex\'s', () => {
    const result = runHook('pre-compact.js', { session_id: SESSION, cwd: ROOT, trigger: 'auto' });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes('CONTEXT CHECKPOINT COMPACTION'));
    assert.ok(result.stdout.includes('Summarize each turn together with the turn'));
  });

  it('PreCompact still honours a manual /compact instruction', () => {
    const result = runHook('pre-compact.js', {
      session_id: SESSION,
      cwd: ROOT,
      trigger: 'manual',
      custom_instructions: 'focus on the failing test',
    });
    assert.ok(result.stdout.includes('focus on the failing test'));
    assert.ok(result.stdout.includes('CONTEXT CHECKPOINT COMPACTION'));
  });

  it('SessionStart(compact) replays the prompt verbatim with its tool results', () => {
    runHook('user-prompt-submit.js', { session_id: SESSION, cwd: ROOT, prompt: PROMPT_TWO });

    const result = runHook('session-start.js', { session_id: SESSION, cwd: ROOT, source: 'compact' });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(PROMPT_ONE), 'the first instruction survives compaction word for word');
    assert.ok(result.stdout.includes(PROMPT_TWO));
    assert.ok(result.stdout.includes('cargo test'), 'tool arguments survive');
    assert.ok(result.stdout.includes('2 passed; 1 failed'), 'tool results survive');
    assert.ok(result.stdout.includes('<bandaid-restored-context>'));
  });

  it('SessionStart(startup) injects nothing', () => {
    const result = runHook('session-start.js', { session_id: SESSION, cwd: ROOT, source: 'startup' });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '');
  });

  it('Stop lets a turn that changed nothing end untouched', () => {
    // PROMPT_TWO is the live goal but no tool has run against it yet.
    const result = runHook('stop.js', { session_id: SESSION, cwd: ROOT, stop_hook_active: false });
    assert.equal(result.code, 0, 'a read-only turn is not worth a completion audit');
  });

  it('Stop blocks an unfinished goal with the completion audit', () => {
    runHook('post-tool-batch.js', {
      session_id: SESSION,
      cwd: ROOT,
      tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: '/repo/src/lib.rs' }, tool_response: 'Applied 1 edit' }],
    });

    const result = runHook('stop.js', { session_id: SESSION, cwd: ROOT, stop_hook_active: false });
    assert.equal(result.code, 2, 'exit 2 is what hands feedback back to the model');
    assert.ok(result.stderr.includes('Completion audit'));
    assert.ok(result.stderr.includes(PROMPT_TWO), 'the objective is the live user request');
    assert.ok(result.stderr.includes('goal complete'), 'the model is told how to close it');
  });

  it('Stop never loops: stop_hook_active always lets the turn end', () => {
    const result = runHook('stop.js', { session_id: SESSION, cwd: ROOT, stop_hook_active: true });
    assert.equal(result.code, 0);
    assert.equal(result.stderr.trim(), '');
  });

  it('Stop gives up once the continuation budget is spent', () => {
    // One continuation was already consumed above; default budget is 2.
    const second = runHook('stop.js', { session_id: SESSION, cwd: ROOT, stop_hook_active: false });
    assert.equal(second.code, 2);

    const third = runHook('stop.js', { session_id: SESSION, cwd: ROOT, stop_hook_active: false });
    assert.equal(third.code, 0, 'a goal the model cannot finish degrades into a normal stop');
  });

  it('marking the goal complete stops the blocking immediately', () => {
    runHook('user-prompt-submit.js', { session_id: SESSION, cwd: ROOT, prompt: 'Add the changelog entry please' });
    runHook('post-tool-batch.js', {
      session_id: SESSION,
      cwd: ROOT,
      tool_calls: [{ tool_name: 'Write', tool_input: { file_path: 'CHANGELOG.md' }, tool_response: 'ok' }],
    });

    assert.equal(runHook('stop.js', { session_id: SESSION, cwd: ROOT }).code, 2, 'blocks while open');
    cli(['goal', 'complete', '--session', SESSION]);
    assert.equal(runHook('stop.js', { session_id: SESSION, cwd: ROOT }).code, 0, 'allows once closed');
  });

  it('the kill switch disables every hook', () => {
    cli(['off']);
    try {
      runHook('user-prompt-submit.js', { session_id: SESSION, cwd: ROOT, prompt: 'Another real instruction here' });
      const stop = runHook('stop.js', { session_id: SESSION, cwd: ROOT });
      assert.equal(stop.code, 0);
      const compact = runHook('pre-compact.js', { session_id: SESSION, cwd: ROOT, trigger: 'auto' });
      assert.equal(compact.stdout.trim(), '');
    } finally {
      cli(['on']);
    }
  });
});

describe('batch timing', () => {
  const SESSION_T = 'e2e-session-timing';

  function batch(sessionId) {
    return runHook('post-tool-batch.js', {
      session_id: sessionId,
      cwd: ROOT,
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: 'ok' }],
    });
  }

  function turns(sessionId) {
    const file = path.join(HOME, 'sessions', sessionId, 'turns.jsonl');
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('carries a null duration on the first batch, never a zero', () => {
    runHook('user-prompt-submit.js', { session_id: SESSION_T, cwd: ROOT, prompt: 'Do a thing with several steps' });
    batch(SESSION_T);

    const [first] = turns(SESSION_T);
    assert.equal(first.timing, 'none');
    assert.equal(first.durationMs, null, 'a zero would be folded into a profile and drag every estimate down');
  });

  it('measures the gap to the previous batch, and says that is what it measured', () => {
    // A real interval, so this asserts against a number rather than a shape. The
    // gap contains everything between two batches completing, which is why it is
    // labelled `gap` and not treated as tool duration.
    const waited = 420;
    execFileSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waited})`]);
    batch(SESSION_T);

    const all = turns(SESSION_T);
    const latest = all[all.length - 1];
    assert.equal(latest.timing, 'gap');
    assert.ok(
      latest.durationMs >= waited,
      `recorded ${latest.durationMs}ms for a ${waited}ms wait — a gap is a ceiling, so it may exceed but never undershoot`,
    );
    assert.ok(latest.durationMs < waited + 20_000, `recorded ${latest.durationMs}ms, which is not a plausible gap`);
    assert.ok(latest.startedAt, 'the previous batch it measured from is recorded');
  });

  it('prefers timing the payload supplies over the gap it would have guessed', () => {
    const session = 'e2e-session-timing-hook';
    runHook('user-prompt-submit.js', { session_id: session, cwd: ROOT, prompt: 'Another multi-step instruction' });
    runHook('post-tool-batch.js', {
      session_id: session,
      cwd: ROOT,
      duration_ms: 1234,
      tool_calls: [{ tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: 'ok' }],
    });

    const [record] = turns(session);
    assert.equal(record.timing, 'hook');
    assert.equal(record.durationMs, 1234);
  });
});

describe('verification gate', () => {
  const SESSION_CHECK = 'e2e-session-check';

  function armGoal(sessionId, prompt, env = {}) {
    runHook('user-prompt-submit.js', { session_id: sessionId, cwd: ROOT, prompt }, env);
    runHook('post-tool-batch.js', {
      session_id: sessionId,
      cwd: ROOT,
      tool_calls: [{ tool_name: 'Edit', tool_input: { file_path: '/repo/src/auth.ts' }, tool_response: 'Applied 1 edit' }],
    }, env);
  }

  it('a passing check closes the goal without waiting to be told', () => {
    armGoal(SESSION_CHECK, 'Migrate the auth module off JWT entirely');

    const result = runHook(
      'stop.js',
      { session_id: SESSION_CHECK, cwd: ROOT, stop_hook_active: false },
      { BANDAID_GOAL_CHECK: 'exit 0' },
    );
    assert.equal(result.code, 0, 'proof outranks the model in the generous direction too');

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', SESSION_CHECK, 'goal.json'), 'utf8'));
    assert.equal(goal.status, 'complete');
  });

  it('a failing check blocks the stop and hands back the real output', () => {
    const session = 'e2e-session-check-fail';
    armGoal(session, 'Make the whole suite green before shipping');

    const result = runHook(
      'stop.js',
      { session_id: session, cwd: ROOT, stop_hook_active: false },
      { BANDAID_GOAL_CHECK: 'echo "FAIL src/auth.test.ts:41"; exit 1' },
    );
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes('FAIL src/auth.test.ts:41'), 'the model gets the failure, not another sermon');
    assert.ok(result.stderr.includes('not up for debate'), 'and it is framed as external, not as self-assessment');
  });

  // The clock, end to end. best-goal-report.md specified budgets on turns, tokens
  // and wall-clock; these are the first tests that any elapsed figure reaches the
  // model at all.
  it('hands the model the time, its goal age, and its wall-clock budget', () => {
    const session = 'e2e-session-elapsed';
    const env = { BANDAID_TIME_BUDGET: '6h' };
    armGoal(session, 'Rebuild the ingestion pipeline end to end', env);

    const result = runHook('stop.js', { session_id: session, cwd: ROOT }, env);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^Elapsed:$/m, 'the block reaches the model');
    assert.match(result.stderr, /^- Now: \d{2}:\d{2} \(\w{3} \d{1,2} \w{3}\)$/m);
    assert.match(result.stderr, /^- This goal: (just now|\d+m|\d+h( \d+m)?) of 6h$/m, 'against its budget');
  });

  it('says nothing about elapsed time when there is no start to measure from', () => {
    // A goal record written before startedAt existed must not render a clause with
    // no input, and must not read as a spent budget either.
    const session = 'e2e-session-no-clock';
    armGoal(session, 'Port the remaining handlers to the new router');
    const goalFile = path.join(HOME, 'sessions', session, 'goal.json');
    const goal = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    fs.writeFileSync(goalFile, JSON.stringify({ ...goal, startedAt: null, createdAt: null }));

    const result = runHook('stop.js', { session_id: session, cwd: ROOT });
    assert.equal(result.code, 2, 'an unknown elapsed is not an exhausted budget');
    assert.doesNotMatch(result.stderr, /^Elapsed:$/m);
  });

  it('wraps up a goal that has run out of wall-clock', () => {
    const session = 'e2e-session-time-budget';
    const env = { BANDAID_TIME_BUDGET: '1h', BANDAID_MAX_CONTINUATIONS: '10' };
    armGoal(session, 'Reconcile the two billing ledgers', env);

    // Backdate the start past the budget. Nothing else about the goal changes, so
    // the only reason this stop can wrap up is the clock.
    const goalFile = path.join(HOME, 'sessions', session, 'goal.json');
    const goal = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    fs.writeFileSync(
      goalFile,
      JSON.stringify({ ...goal, startedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() }),
    );

    const result = runHook('stop.js', { session_id: session, cwd: ROOT }, env);
    assert.equal(result.code, 2, 'an explicit budget earns the wrap-up turn');
    assert.match(result.stderr, /budget/i);

    const after = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    assert.equal(after.status, 'budget_limited');
  });

  it('hands the model one capacity line with a measured ETA in it', () => {
    // The end-to-end path for criterion 3: task durations recorded by the ledger,
    // projected by the estimator, rendered into the prompt the model actually gets.
    const session = 'e2e-session-eta';
    armGoal(session, 'Rewrite the ingestion layer and its tests');

    // Written with fs rather than by calling tasks.observe in this process. This
    // suite is subprocess-only on purpose: the state dir is chosen by an env var
    // the *child* gets, so an in-process write lands in the real ~/.claude/bandaid
    // instead of the throwaway one.
    const MINUTE = 60_000;
    const events = [];
    let clock = Date.parse('2026-07-30T09:00:00.000Z');
    const at = (ms) => new Date((clock += ms)).toISOString();
    for (let i = 1; i <= 8; i += 1) {
      events.push({ ts: at(1000), turnIndex: 1, taskId: `task:${i}`, title: `Step ${i}`, status: 'pending', matchedBy: 'id' });
    }
    for (const [id, minutes] of [[1, 10], [2, 12], [3, 9]]) {
      events.push({ ts: at(1000), turnIndex: 1, taskId: `task:${id}`, status: 'in_progress', matchedBy: 'id' });
      events.push({ ts: at(minutes * MINUTE), turnIndex: 1, taskId: `task:${id}`, status: 'completed', matchedBy: 'id' });
    }
    fs.writeFileSync(
      path.join(HOME, 'sessions', session, 'tasks.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );

    const result = runHook('stop.js', { session_id: session, cwd: ROOT });
    assert.equal(result.code, 2);
    // Median of 10/12/9 is 10 minutes, five tasks left, so 50 minutes.
    assert.match(result.stderr, /^Capacity: .*~50m left \(5 tasks, /m);
    assert.match(result.stderr, /continuation 1\/2/);
    assert.doesNotMatch(result.stderr, /^Budget:$/m, 'the four-line block it replaced is gone');
  });

  // Four runs, two exit codes, asserted both ways: a permission-ask and a genuine
  // question, with autonomy off and on. This is the end-to-end contract for "work
  // on larger tasks without stopping to ask permission".
  describe('autonomy, end to end', () => {
    const PERMISSION = 'The first module is done.\n\nShould I proceed?';
    const GENUINE = 'One thing I cannot work out:\n\nWhat should the retry limit be?';

    function stopWith(session, message, env) {
      armGoal(session, 'Rebuild the ingestion pipeline and its tests', env);
      return runHook('stop.js', { session_id: session, cwd: ROOT, last_assistant_message: message }, env);
    }

    it('off: a permission-ask ends the turn, as it always has', () => {
      const result = stopWith('e2e-auto-off-perm', PERMISSION, {});
      assert.equal(result.code, 0);
    });

    it('off: a genuine question ends the turn', () => {
      const result = stopWith('e2e-auto-off-real', GENUINE, {});
      assert.equal(result.code, 0);
    });

    it('on: a permission-ask does not end the turn, and is told to decide', () => {
      const result = stopWith('e2e-auto-on-perm', PERMISSION, { BANDAID_AUTONOMY: '1' });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /asking permission to do work already in scope/);
      assert.match(result.stderr, /Decide it yourself/);
      assert.match(result.stderr, /goal block/, 'and a real need is routed to the blocker mechanism');
    });

    it('on: a genuine question still ends the turn', () => {
      // The failure that must never happen: a question the user never gets asked.
      const result = stopWith('e2e-auto-on-real', GENUINE, { BANDAID_AUTONOMY: '1' });
      assert.equal(result.code, 0, 'blocking this would trap the user in a loop');
    });

    it('on: an ordinary turn gets no autonomy paragraph', () => {
      const result = stopWith('e2e-auto-on-plain', 'Finished the first module.', { BANDAID_AUTONOMY: '1' });
      assert.equal(result.code, 2);
      assert.doesNotMatch(result.stderr, /asking permission to continue/, 'it costs nothing on any other path');
    });
  });

  it('refunds a round whose check output actually changed', () => {
    // The end-to-end path for the earned leash: two rounds, a different failure
    // each time, so the second round costs nothing and the leash lengthens.
    const session = 'e2e-session-refund';
    const first = { BANDAID_GOAL_CHECK: 'echo "3 tests failing"; exit 1', BANDAID_MAX_CONTINUATIONS: '10' };
    armGoal(session, 'Get the whole suite green', first);
    const goalFile = path.join(HOME, 'sessions', session, 'goal.json');

    runHook('stop.js', { session_id: session, cwd: ROOT }, first);
    const afterOne = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    assert.equal(afterOne.continuations, 1, 'the first round has nothing to compare against');
    assert.equal(afterOne.refunded, 0);

    const second = { BANDAID_GOAL_CHECK: 'echo "1 test failing"; exit 1', BANDAID_MAX_CONTINUATIONS: '10' };
    runHook('stop.js', { session_id: session, cwd: ROOT }, second);
    const afterTwo = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    assert.equal(afterTwo.continuations, 1, '"3 failing" becoming "1 failing" is progress, so the round was free');
    assert.equal(afterTwo.refunded, 1);
    assert.equal(afterTwo.lastProgressSignal, 'verdict-changed');
  });

  it('charges double for a second round that changed nothing', () => {
    const session = 'e2e-session-stall';
    const env = { BANDAID_GOAL_CHECK: 'echo "identical failure"; exit 1', BANDAID_MAX_CONTINUATIONS: '10' };
    armGoal(session, 'Fix the flaky integration test for good', env);
    const goalFile = path.join(HOME, 'sessions', session, 'goal.json');

    runHook('stop.js', { session_id: session, cwd: ROOT }, env);
    assert.equal(JSON.parse(fs.readFileSync(goalFile, 'utf8')).continuations, 1);

    runHook('stop.js', { session_id: session, cwd: ROOT }, env);
    const after = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    // Two stalls running: this round cost 2, so a goal going nowhere runs out
    // sooner than it did before any of this existed.
    assert.equal(after.continuations, 3);
    assert.equal(after.stalls, 2);
  });

  it('the same failure twice running ends the loop early', () => {
    const session = 'e2e-session-plateau';
    const failing = { BANDAID_GOAL_CHECK: 'echo "identical failure"; exit 1', BANDAID_MAX_CONTINUATIONS: '10' };
    // The cap has to be raised when the goal is created; it is stamped onto the
    // goal, not read from config at stop time.
    armGoal(session, 'Fix the flaky integration test for good', failing);

    const first = runHook('stop.js', { session_id: session, cwd: ROOT }, failing);
    assert.equal(first.code, 2);

    const second = runHook('stop.js', { session_id: session, cwd: ROOT }, failing);
    assert.equal(second.code, 2);

    // Third identical verdict: the loop has stopped converging well short of
    // the 10 continuations it was allowed.
    const third = runHook('stop.js', { session_id: session, cwd: ROOT }, failing);
    assert.ok(third.stderr.includes('reached its continuation budget'), 'a plateau is not worth another seven turns');

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', session, 'goal.json'), 'utf8'));
    assert.equal(goal.status, 'budget_limited');
  });

  it('stops continuing a goal the environment has walled off', () => {
    const session = 'e2e-session-blocked';
    armGoal(session, 'Confirm the render fix on real hardware and update the docs');

    assert.equal(runHook('stop.js', { session_id: session, cwd: ROOT }).code, 2, 'blocks while nothing is blocked');

    cli(['goal', 'block', '--session', session, 'confirming the render fix needs a GPU this session has no access to']);
    cli(['goal', 'block', '--session', session, 'the second half needs a live service that is not running']);

    // The saving: this stop is allowed through with continuations still on the
    // clock, rather than spending every one of them re-asking for hardware.
    const result = runHook('stop.js', { session_id: session, cwd: ROOT });
    assert.equal(result.code, 0, 'another turn cannot supply hardware that is absent');

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', session, 'goal.json'), 'utf8'));
    assert.equal(goal.status, 'blocked');
    assert.equal(goal.blockers.length, 2);
  });

  it('re-injects recorded blockers so the next turn stops re-attempting them', () => {
    const session = 'e2e-session-blocker-echo';
    armGoal(session, 'Verify the overlay renders and cover it with tests');

    cli(['goal', 'block', '--session', session, 'driving the overlay needs a browser this session cannot open']);
    const result = runHook('stop.js', { session_id: session, cwd: ROOT });
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes('needs a browser this session cannot open'), 'the blocker comes back with the goal');
    assert.ok(result.stderr.includes('do not re-argue them'), 'and it comes back as settled, not as an open question');
  });

  it('a failing check outranks a blocker, because a failing test is not a missing GPU', () => {
    const session = 'e2e-session-blocked-but-failing';
    const failing = { BANDAID_GOAL_CHECK: 'echo "FAIL src/render.test.ts:12"; exit 1' };
    armGoal(session, 'Make the render suite pass on the current hardware', failing);

    cli(['goal', 'block', '--session', session, 'first blocker']);
    cli(['goal', 'block', '--session', session, 'second blocker']);

    const result = runHook('stop.js', { session_id: session, cwd: ROOT }, failing);
    assert.equal(result.code, 2, 'ground truth still outranks the model on what it cannot do');
    assert.ok(result.stderr.includes('FAIL src/render.test.ts:12'));
  });

  it('a violated constraint ends the goal instead of extending it', () => {
    const session = 'e2e-session-violated';
    // A stub standing in for the judge, so the verdict is driven rather than
    // fetched. What is under test is what the Stop hook does with it.
    const stub = path.join(HOME, 'judge-violated.sh');
    fs.writeFileSync(
      stub,
      '#!/bin/sh\necho "VERDICT: violated"\necho "REASON: vendor/ was deleted, which the objective said to leave alone"\n',
    );
    fs.chmodSync(stub, 0o755);
    const judging = { BANDAID_JUDGE: '1', BANDAID_JUDGE_CLI: stub };

    armGoal(session, 'Tidy the repository without touching vendor/', judging);

    const first = runHook('stop.js', { session_id: session, cwd: ROOT }, judging);
    assert.equal(first.code, 2, 'the user is told once');
    assert.ok(first.stderr.includes('vendor/ was deleted'), 'and told what was violated');
    assert.ok(first.stderr.includes('Do not attempt the recovery'), 'without improvising a remedy');

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', session, 'goal.json'), 'utf8'));
    assert.equal(goal.status, 'blocked', 'a violation is terminal — no further attempt can undo it');
    assert.deepEqual(goal.constraints, ['Tidy the repository without touching vendor/']);

    const second = runHook('stop.js', { session_id: session, cwd: ROOT }, judging);
    assert.equal(second.code, 0, 'and it never blocks twice');
  });

  it('a check that cannot run is treated as unproven, never as proof', () => {
    const session = 'e2e-session-badcheck';
    armGoal(session, 'Ship the parser rewrite with tests');

    const result = runHook(
      'stop.js',
      { session_id: session, cwd: ROOT },
      { BANDAID_GOAL_CHECK: 'definitely-not-a-real-command-xyz' },
    );
    assert.equal(result.code, 2, 'a broken check must not silently close goals');
  });
});

describe('session isolation', () => {
  it('a fresh session in the same directory does not inherit the previous ledger', () => {
    const fresh = 'e2e-session-fresh';
    runHook('session-start.js', { session_id: fresh, cwd: ROOT, source: 'startup' });
    runHook('user-prompt-submit.js', { session_id: fresh, cwd: ROOT, prompt: 'A brand new unrelated task' });

    const prompts = fs.readFileSync(path.join(HOME, 'sessions', fresh, 'prompts.jsonl'), 'utf8');
    assert.ok(prompts.includes('A brand new unrelated task'));
    assert.ok(!prompts.includes(PROMPT_ONE), 'must not replay another conversation');
  });

  it('a forked session does carry the ledger forward', () => {
    const forked = 'e2e-session-forked';
    // The pointer currently names the fresh session, which has one prompt.
    runHook('session-start.js', { session_id: forked, cwd: ROOT, source: 'fork' });

    const prompts = fs.readFileSync(path.join(HOME, 'sessions', forked, 'prompts.jsonl'), 'utf8');
    assert.ok(prompts.includes('A brand new unrelated task'), 'a fork continues the conversation it came from');
  });
});

describe('hook wiring', () => {
  // The plugin path reads hooks/hooks.json; `bandaid install` writes settings.json
  // from install.js. They disagreed on two timeouts once, and the only symptom
  // was that the two install paths behaved differently under load.
  it('the plugin manifest and the installer agree on every event and timeout', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const { HOOK_EVENTS } = require(path.join(ROOT, 'src', 'lib', 'install.js'));

    assert.deepEqual(
      Object.keys(manifest).sort(),
      HOOK_EVENTS.map((spec) => spec.event).sort(),
      'both install paths must wire the same events',
    );

    for (const spec of HOOK_EVENTS) {
      const [entry] = manifest[spec.event];
      assert.equal(entry.hooks[0].timeout, spec.timeout, `${spec.event} timeout must match`);
      assert.ok(entry.hooks[0].command.includes(spec.file), `${spec.event} must point at ${spec.file}`);
    }
  });

  it('gives the Stop hook more time than the verifier it has to run', () => {
    const { HOOK_EVENTS } = require(path.join(ROOT, 'src', 'lib', 'install.js'));
    const { DEFAULTS } = require(path.join(ROOT, 'src', 'lib', 'config.js'));
    const stop = HOOK_EVENTS.find((spec) => spec.event === 'Stop');

    assert.ok(
      stop.timeout * 1000 > DEFAULTS.goals.verifyTimeoutMs,
      'a Stop hook killed mid-verdict does not exit 2, so the stop goes through unverified',
    );
  });
});

describe('goals across a resume', () => {
  // A directory of its own: the per-cwd pointer is what a resume adopts
  // through, and the lifecycle suites above have already claimed ROOT's.
  const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-resume-'));
  after(() => fs.rmSync(WORKDIR, { recursive: true, force: true }));

  const DAY_ONE = 'e2e-resume-day-one';
  const DAY_TWO = 'e2e-resume-day-two';
  const OBJECTIVE = 'Port the retry logic to the new client without touching vendor/';

  it('carries an open objective, its criteria, constraints and blockers into the new session', () => {
    runHook('user-prompt-submit.js', { session_id: DAY_ONE, cwd: WORKDIR, prompt: OBJECTIVE });
    cli(['goal', 'criteria', '--session', DAY_ONE, '--', 'retries use exponential backoff', 'retryLegacy is gone']);
    cli(['goal', 'block', '--session', DAY_ONE, '--', 'the staging endpoint needs a VPN this session cannot reach']);

    const resumed = runHook('session-start.js', { session_id: DAY_TWO, cwd: WORKDIR, source: 'resume' });

    assert.equal(resumed.code, 0);
    assert.ok(
      fs.existsSync(path.join(HOME, 'sessions', DAY_TWO, 'goal.json')),
      'the goal must travel with the ledger, or the resumed session has the history of an objective it no longer has',
    );

    assert.ok(resumed.stdout.includes(OBJECTIVE), 'the objective is restated');
    assert.ok(resumed.stdout.includes('retries use exponential backoff'), 'the fixed bar travels with it');
    assert.ok(resumed.stdout.includes('vendor/'), 'the constraint travels with it');
    assert.ok(resumed.stdout.includes('needs a VPN'), 'so does what was already ruled impossible');
    assert.ok(resumed.stdout.includes('do not re-argue them'), 'and it is marked as settled, not as a task');
  });

  it('does not resurrect an objective that was already closed', () => {
    const closed = 'e2e-resume-closed';
    cli(['goal', 'complete', '--session', DAY_TWO]);
    runHook('session-start.js', { session_id: closed, cwd: WORKDIR, source: 'resume' });

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', DAY_TWO, 'goal.json'), 'utf8'));
    assert.equal(goal.status, 'complete');
    assert.ok(
      !fs.existsSync(path.join(HOME, 'sessions', closed, 'goal.json')),
      're-arming a stop that has already been settled is worse than losing it',
    );
  });
});

describe('an objective that outlives its session', () => {
  const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-carry-'));
  after(() => fs.rmSync(WORKDIR, { recursive: true, force: true }));

  const OBJECTIVE = 'Replace the polling sync with a websocket transport, do not break the REST fallback';

  it('records the objective against the project, not only the session', () => {
    runHook('user-prompt-submit.js', { session_id: 'carry-day-one', cwd: WORKDIR, prompt: OBJECTIVE });
    cli(['goal', 'criteria', '--session', 'carry-day-one', '--', 'ws client connects on start', 'REST fallback still passes']);

    const handoff = JSON.parse(cli(['goal', 'history', '--cwd', WORKDIR, '--json']));
    assert.equal(handoff.goal.objective, OBJECTIVE);
    assert.equal(handoff.goal.criteria.length, 2);
    assert.deepEqual(handoff.goal.sessions, ['carry-day-one']);
  });

  it('offers it to a brand-new session without arming anything', () => {
    const result = runHook('session-start.js', { session_id: 'carry-offer', cwd: WORKDIR, source: 'startup' });

    assert.ok(result.stdout.includes(OBJECTIVE), 'the objective is named');
    assert.ok(result.stdout.includes('ws client connects on start'), 'so is the bar it was fixed at');
    assert.ok(result.stdout.includes('NOT working that objective'), 'and the fact that nothing is armed');
    assert.ok(result.stdout.includes('goal adopt'), 'with the one command that takes it up');
    assert.ok(result.stdout.includes('goal clear --project'), 'and the one that drops it');

    assert.ok(
      !fs.existsSync(path.join(HOME, 'sessions', 'carry-offer', 'goal.json')),
      'offering must not create a goal; adoption is a decision, not an accident',
    );
  });

  it('takes it up on request, with the bar intact and the budget fresh', () => {
    cli(['goal', 'adopt', '--session', 'carry-offer', '--cwd', WORKDIR]);

    const goal = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'carry-offer', 'goal.json'), 'utf8'));
    assert.equal(goal.objective, OBJECTIVE);
    assert.equal(goal.criteria.length, 2);
    assert.equal(goal.continuations, 0);
    assert.equal(goal.adoptedFrom, 'carry-day-one');
  });

  it('adopts it outright when told to run unattended', () => {
    const result = runHook(
      'session-start.js',
      { session_id: 'carry-auto', cwd: WORKDIR, source: 'startup' },
      { BANDAID_CARRY_OVER: 'auto' },
    );

    assert.ok(result.stdout.includes('Resuming the objective'));
    assert.ok(fs.existsSync(path.join(HOME, 'sessions', 'carry-auto', 'goal.json')));
  });

  it('says nothing at all when carry-over is off', () => {
    const result = runHook(
      'session-start.js',
      { session_id: 'carry-off', cwd: WORKDIR, source: 'startup' },
      { BANDAID_CARRY_OVER: 'off' },
    );

    assert.equal(result.stdout.trim(), '');
    assert.ok(!fs.existsSync(path.join(HOME, 'sessions', 'carry-off', 'goal.json')));
  });

  it('survives a /clear, which drops the session copy and keeps the project record', () => {
    runHook('session-start.js', { session_id: 'carry-auto', cwd: WORKDIR, source: 'clear' });

    assert.ok(
      !fs.existsSync(path.join(HOME, 'sessions', 'carry-auto', 'goal.json')),
      'a cleared conversation must not drag its objective into the next one',
    );
    const handoff = JSON.parse(cli(['goal', 'history', '--cwd', WORKDIR, '--json']));
    assert.equal(handoff.goal.objective, OBJECTIVE, 'clearing scrollback is not the same as abandoning the work');
  });

  it('stops offering once the objective is closed', () => {
    cli(['goal', 'complete', '--session', 'carry-offer']);
    const result = runHook('session-start.js', { session_id: 'carry-after', cwd: WORKDIR, source: 'startup' });
    assert.equal(result.stdout.trim(), '');
  });

  it('drops the project record when that is what was meant', () => {
    cli(['goal', 'clear', '--project', '--cwd', WORKDIR]);
    assert.match(cli(['goal', 'history', '--cwd', WORKDIR]), /No open objective/);
  });
});

describe('hook robustness', () => {
  it('survives empty, malformed, and hostile input without failing the session', () => {
    for (const script of ['user-prompt-submit.js', 'post-tool-batch.js', 'pre-compact.js', 'post-compact.js', 'session-start.js', 'stop.js']) {
      for (const input of [{}, { session_id: '' }, { session_id: '../../escape' }, { session_id: SESSION, tool_calls: 'not-an-array' }]) {
        const result = runHook(script, input);
        assert.notEqual(result.code, 1, `${script} must not hard-fail on ${JSON.stringify(input)}`);
      }
    }
  });

  it('refuses to write outside the state dir', () => {
    runHook('user-prompt-submit.js', { session_id: '../../../etc/evil', cwd: ROOT, prompt: 'x'.repeat(50) });
    assert.ok(!fs.existsSync(path.join(HOME, '..', '..', '..', 'etc', 'evil')));
  });
});
