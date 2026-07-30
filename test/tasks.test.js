'use strict';

/**
 * The task ledger.
 *
 * The failure this exists to catch is a plausible duration that is fiction. Get a
 * match wrong and nothing errors — the ledger simply reports that a task took
 * eleven minutes when it was really two different tasks, and the estimator built
 * on top projects from it with a straight face.
 *
 * The two sources are not equally dangerous. TaskCreate/TaskUpdate carry a stable
 * id and every number is a subtraction. TodoWrite replaces the whole list and
 * gives nothing an identity, so those cases are where the corpus earns its keep.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-tasks-'));
process.env.BANDAID_HOME = HOME;

const tasks = require('../src/lib/tasks');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const MINUTE = 60_000;
let seq = 0;
const session = (name) => `${name}-${(seq += 1)}`;

/** Replay a scripted sequence of tool calls at controlled times. */
function replay(sessionId, calls) {
  let clock = Date.parse('2026-07-30T10:00:00.000Z');
  calls.forEach((call, i) => {
    clock += (call.afterMs ?? MINUTE);
    tasks.observe(sessionId, {
      toolName: call.tool,
      input: call.input,
      result: call.result,
      turnIndex: i + 1,
      now: clock,
    });
  });
  return tasks.state(sessionId);
}

const create = (id, subject) => ({
  tool: 'TaskCreate',
  input: { subject },
  result: `Task #${id} created successfully: ${subject}`,
});
const update = (id, status, afterMs) => ({ tool: 'TaskUpdate', input: { taskId: String(id), status }, afterMs });
const todos = (list, afterMs) => ({ tool: 'TodoWrite', input: { todos: list }, afterMs });

describe('idFromCreateResult', () => {
  it('reads the id out of the result prose, which is the only place it appears', () => {
    assert.equal(tasks.idFromCreateResult('Task #12 created successfully: Do the thing'), '12');
    assert.equal(tasks.idFromCreateResult('Task #1 created successfully: x'), '1');
  });

  it('records nothing rather than inventing an id when the prose changes', () => {
    // This is the one place the id path can silently stop working, so it has to
    // fail closed.
    assert.equal(tasks.idFromCreateResult('Created a task for you'), null);
    assert.equal(tasks.idFromCreateResult(''), null);
    assert.equal(tasks.idFromCreateResult(null), null);
  });
});

describe('the id path — TaskCreate / TaskUpdate', () => {
  it('measures a duration as a subtraction between two stamped events', () => {
    const state = replay(session('linear'), [
      create(1, 'Write the parser'),
      update(1, 'in_progress'),
      update(1, 'completed', 11 * MINUTE),
    ]);
    assert.equal(state.total, 1);
    assert.equal(state.completed, 1);
    assert.deepEqual(state.durations, [11 * MINUTE]);
    assert.equal(state.tasks[0].matchedBy, 'id');
    assert.equal(state.fuzzyDurations, 0, 'nothing here was guessed');
  });

  it('counts a plan in flight without pretending to know how it ends', () => {
    const state = replay(session('inflight'), [
      create(1, 'One'),
      create(2, 'Two'),
      create(3, 'Three'),
      update(1, 'completed'),
      update(2, 'in_progress'),
    ]);
    assert.equal(state.total, 3);
    assert.equal(state.completed, 1);
    assert.equal(state.inProgress, 1);
    assert.equal(state.pending, 1);
  });

  it('gives a task that never went in_progress no duration, rather than zero', () => {
    const state = replay(session('skipped'), [create(1, 'Quick one'), update(1, 'completed')]);
    assert.equal(state.completed, 1);
    assert.deepEqual(state.durations, [], 'a zero here would be averaged into an estimate');
  });

  it('measures the second interval from when a reopened task reopened', () => {
    const state = replay(session('reopened'), [
      create(1, 'Fix the flake'),
      update(1, 'in_progress'),
      update(1, 'completed', 5 * MINUTE),
      update(1, 'in_progress', 30 * MINUTE),
      update(1, 'completed', 2 * MINUTE),
    ]);
    assert.deepEqual(state.durations, [2 * MINUTE], 'not 37 minutes, and not a negative');
  });

  it('does not let a rename reset a task to pending', () => {
    const state = replay(session('renamed'), [
      create(1, 'Write the parser'),
      update(1, 'in_progress'),
      { tool: 'TaskUpdate', input: { taskId: '1', subject: 'Write the parser, properly' } },
      update(1, 'completed', 3 * MINUTE),
    ]);
    assert.equal(state.completed, 1);
    assert.equal(state.tasks[0].title, 'Write the parser, properly');
    assert.deepEqual(state.durations, [4 * MINUTE], 'the clock ran through the rename');
  });

  it('ignores a malformed call instead of recording a phantom task', () => {
    const id = session('garbage');
    const state = replay(id, [
      { tool: 'TaskCreate', input: { subject: 'No id in the result' }, result: 'ok' },
      { tool: 'TaskUpdate', input: {} },
      { tool: 'TaskUpdate', input: { taskId: null, status: 'completed' } },
      create(1, 'The real one'),
    ]);
    assert.equal(state.total, 1);
    assert.equal(state.tasks[0].title, 'The real one');
  });
});

describe('the list path — TodoWrite', () => {
  const t = (content, status) => ({ content, status });

  it('follows a task through its statuses by content', () => {
    const id = session('todo-linear');
    const state = replay(id, [
      todos([t('Add retry logic', 'pending'), t('Write the test', 'pending')]),
      todos([t('Add retry logic', 'in_progress'), t('Write the test', 'pending')]),
      todos([t('Add retry logic', 'completed'), t('Write the test', 'in_progress')], 9 * MINUTE),
    ]);
    assert.equal(state.total, 2);
    assert.equal(state.completed, 1);
    assert.deepEqual(state.durations, [9 * MINUTE]);
  });

  it('takes an append as new work, not as a rewrite', () => {
    const state = replay(session('todo-append'), [
      todos([t('One', 'pending'), t('Two', 'pending')]),
      todos([t('One', 'completed'), t('Two', 'pending'), t('Three', 'pending')]),
    ]);
    assert.equal(state.total, 3);
    assert.equal(state.dropped, 0, 'nothing vanished, so nothing may be marked dropped');
  });

  it('carries a duration across a reword, and says the match was guessed', () => {
    const state = replay(session('todo-reword'), [
      todos([t('Add retry logic', 'in_progress')]),
      todos([t('Add retry logic to the client', 'completed')], 7 * MINUTE),
    ]);
    assert.equal(state.total, 1, 'a reword is one task, not two');
    assert.deepEqual(state.durations, [7 * MINUTE]);
    assert.equal(state.fuzzyDurations, 1, 'and the number is flagged as resting on a guess');
  });

  it('records a vanished task as dropped, never as done', () => {
    // Inferring completion from absence would make every restructure look like a
    // burst of productivity, and the estimator would project from phantom work.
    const state = replay(session('todo-restructure'), [
      todos([t('A', 'pending'), t('B', 'in_progress'), t('C', 'pending')]),
      todos([t('Rewrite the ingest layer', 'pending'), t('Port the callers', 'pending')], 20 * MINUTE),
    ]);
    assert.equal(state.total, 2, 'the plan now has two tasks, not five');
    assert.equal(state.dropped, 3);
    assert.equal(state.completed, 0);
    assert.deepEqual(state.durations, [], 'a dropped task contributes no duration');
  });

  it('keeps two identically-worded tasks from collapsing into one', () => {
    const state = replay(session('todo-dupes'), [todos([t('Update the docs', 'pending'), t('Update the docs', 'pending')])]);
    // They hash identically, so the second cannot claim the first's id — it gets
    // its own and the count stays honest.
    assert.equal(state.total, 2);
  });

  it('survives a payload that is not a task list at all', () => {
    const id = session('todo-garbage');
    for (const bad of [undefined, null, 'nope', { todos: 'nope' }, { todos: [null, {}, { status: 'pending' }] }]) {
      assert.doesNotThrow(() => tasks.observe(id, { toolName: 'TodoWrite', input: bad, turnIndex: 1 }));
    }
    const state = tasks.state(id);
    // The one entry with neither content nor activeForm still counts as a task with
    // an empty title; what must not happen is a crash or a fabricated duration.
    if (state) assert.deepEqual(state.durations, []);
  });
});

describe('looksReworded', () => {
  it('catches a title extended in place, which Jaccard alone cannot', () => {
    // These two score 0.5 on overlap — below any threshold that also rejects the
    // negative cases below. The prefix rule is what settles it.
    assert.ok(tasks.overlap('Add retry logic', 'Add retry logic to the client') < tasks.REWORD_OVERLAP);
    assert.ok(tasks.looksReworded('Add retry logic', 'Add retry logic to the client'));
    assert.ok(tasks.looksReworded('Add retry logic to the client', 'Add retry logic'), 'and in both directions');
  });

  it('requires a word boundary, so one task cannot claim a longer word', () => {
    assert.ok(!tasks.looksReworded('Port', 'Portability review'));
  });

  it('rejects two different tasks that merely share a word', () => {
    assert.ok(!tasks.looksReworded('Update the docs', 'Update the parser generator config'));
    assert.ok(!tasks.looksReworded('Add retry logic', 'Rewrite the ingest layer'));
  });

  it('declines rather than guessing when there is nothing to compare', () => {
    assert.ok(!tasks.looksReworded('', 'anything'));
    assert.ok(!tasks.looksReworded(null, null));
  });
});

describe('overlap', () => {
  it('is a Jaccard ratio, and is zero against nothing', () => {
    assert.equal(tasks.overlap('a b', 'a b'), 1);
    assert.equal(tasks.overlap('', 'anything'), 0);
    assert.equal(tasks.overlap(null, null), 0);
  });
});

describe('normalizeTitle', () => {
  it('collapses whitespace and case but does not stem', () => {
    assert.equal(tasks.normalizeTitle('  Write   The  Test '), 'write the test');
    // "write the test" and "wrote the tests" must stay distinct: merging them is
    // how a duration becomes fiction.
    assert.notEqual(tasks.normalizeTitle('write the test'), tasks.normalizeTitle('wrote the tests'));
  });
});
