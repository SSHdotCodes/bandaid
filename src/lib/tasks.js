'use strict';

const store = require('./store');
const { fingerprint } = require('./ledger');

/**
 * What the model said it was going to do, and how long each of those took.
 *
 * Bandaid asks for a plan on every continuation — "use TodoWrite to show a
 * concise plan tied to the real objective, and keep it current as steps
 * complete" — and then throws the answer away. The only thing that ever read
 * that data flattened the whole list into a 400-character label and stored it as
 * a string.
 *
 * Two sources, and they are not equally hard:
 *
 *   TaskCreate / TaskUpdate  carry a stable integer id. A status transition is a
 *                            single stamped event and a duration is a
 *                            subtraction. Nothing is inferred.
 *   TodoWrite                replaces the entire list on every call and gives
 *                            nothing a stable identity, so matching a task
 *                            across two writes is a guess. Every heuristic here
 *                            is confined to that path and labelled on the record.
 *
 * Nothing here is authoritative. A criterion is the bar; a task is the model's
 * own decomposition and the model can be wrong about it. This is an observation,
 * and every consumer has to treat it as one — the same posture `evidence.append`
 * takes when it forces a model-supplied claim to `unverified`.
 */

/** Statuses a task can be in, normalized across both sources. */
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'dropped']);

/**
 * How similar two normalized task titles must be to count as the same task
 * reworded. Only used on the TodoWrite path.
 *
 * Deliberately high. README.md records that consecutive judge reasons sat at
 * 0.2–0.7 token overlap with no threshold separating "stuck" from "progressing" —
 * this repository has been burned by exactly this kind of number before, so the
 * bar is set where a false match is unlikely and the rule simply declines to fire
 * the rest of the time.
 */
const REWORD_OVERLAP = 0.6;

function tasksFile(sessionId) {
  return require('node:path').join(store.sessionDir(sessionId), 'tasks.jsonl');
}

/**
 * Trim, collapse whitespace, lowercase. Deliberately no stemming: "write the
 * test" and "wrote the tests" becoming one task is how a duration becomes fiction.
 */
function normalizeTitle(text) {
  return String(text == null ? '' : text)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeStatus(status) {
  const value = String(status == null ? '' : status).trim().toLowerCase();
  if (value === 'complete' || value === 'done') return 'completed';
  if (value === 'inprogress' || value === 'active') return 'in_progress';
  return STATUSES.has(value) ? value : 'pending';
}

function tokens(title) {
  return new Set(normalizeTitle(title).split(' ').filter(Boolean));
}

/** Jaccard overlap, used only to decide whether a TodoWrite entry was reworded. */
function overlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Did this title get reworded, or is it a different task?
 *
 * Two rules, and the first is doing most of the work. Extending a title in place
 * — "Add retry logic" becoming "Add retry logic to the client" — is the common
 * reword, and it is exactly the case Jaccard is worst at: those two score 0.5,
 * below any threshold that also rejects "Update the docs" against "Update the
 * parser generator config". A prefix test settles it without a number.
 *
 * Overlap is the fallback for a reword that is not a prefix, and it is set high
 * enough that it mostly declines to fire.
 */
function looksReworded(before, after) {
  const a = normalizeTitle(before);
  const b = normalizeTitle(after);
  if (!a || !b) return false;
  if (a === b) return true;
  // A prefix match needs a word boundary, or "port" would claim "portability".
  if (b.startsWith(`${a} `) || a.startsWith(`${b} `)) return true;
  return overlap(a, b) >= REWORD_OVERLAP;
}

/** `Task #12 created successfully: …` → `"12"`. */
function idFromCreateResult(result) {
  const match = /task\s*#(\d+)/i.exec(String(result == null ? '' : result));
  return match ? match[1] : null;
}

function append(sessionId, record) {
  store.ensureSessionDir(sessionId);
  store.appendJsonl(tasksFile(sessionId), record);
}

function read(sessionId) {
  return store.readJsonl(tasksFile(sessionId));
}

/**
 * The state a sequence of events describes.
 *
 * `total` excludes dropped tasks — a plan that was restructured did not have
 * sixteen tasks — and reports them separately so the restructure stays visible
 * rather than being hidden by the arithmetic.
 */
function reduceEvents(events) {
  const tasks = new Map();

  for (const event of events) {
    if (!event || !event.taskId) continue;
    const existing = tasks.get(event.taskId) || {
      taskId: event.taskId,
      title: event.title || null,
      status: 'pending',
      matchedBy: event.matchedBy || 'id',
      firstActiveAt: null,
      completedAt: null,
      activeMs: null,
    };

    if (event.title) existing.title = event.title;
    if (event.matchedBy) existing.matchedBy = event.matchedBy;

    const status = normalizeStatus(event.status);
    if (status === 'in_progress' && !existing.firstActiveAt) existing.firstActiveAt = event.ts || null;

    if (status === 'completed') {
      existing.completedAt = event.ts || null;
      const start = existing.firstActiveAt ? Date.parse(existing.firstActiveAt) : NaN;
      const end = existing.completedAt ? Date.parse(existing.completedAt) : NaN;
      // A task that went straight from pending to completed was never observed
      // being worked on, so it has no duration. Recording 0 would be a lie that
      // averages into an estimate.
      existing.activeMs =
        Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : existing.activeMs;
    }

    // A task can come back from completed; the second interval is measured from
    // the moment it reopened rather than from the original start.
    if (status === 'in_progress' && existing.status === 'completed') {
      existing.firstActiveAt = event.ts || null;
      existing.completedAt = null;
    }

    existing.status = status;
    tasks.set(event.taskId, existing);
  }

  return [...tasks.values()];
}

function state(sessionId) {
  const tasks = reduceEvents(events(sessionId));
  if (!tasks.length) return null;

  const live = tasks.filter((t) => t.status !== 'dropped');
  const durations = live.filter((t) => t.activeMs != null).map((t) => t.activeMs);

  return {
    total: live.length,
    completed: live.filter((t) => t.status === 'completed').length,
    inProgress: live.filter((t) => t.status === 'in_progress').length,
    pending: live.filter((t) => t.status === 'pending').length,
    dropped: tasks.length - live.length,
    durations,
    // Durations from a guessed match are excludable, and are excluded from any
    // headline number, because a wrong match produces a plausible duration.
    fuzzyDurations: live.filter((t) => t.activeMs != null && t.matchedBy === 'fuzzy').length,
    tasks,
  };
}

/**
 * The TodoWrite path: diff the incoming list against the last one observed.
 *
 * Returns the events the diff implies. An old task that ends the diff unmatched
 * and not completed is `dropped` — never inferred as done. Inferring completion
 * from absence would make every restructure look like a burst of productivity,
 * and the estimator downstream would be projecting from phantom work.
 */
function diffTodos(previous, todos) {
  const events = [];
  const unmatchedPrevious = new Map(previous.map((t) => [t.taskId, t]));

  // Two tasks can legitimately carry the same words. Content is the only identity
  // available here, so a repeat is disambiguated by how many times it has already
  // appeared in this list — stable across writes as long as their order is, which
  // is the best this path can do.
  const occurrences = new Map();
  const incoming = todos.map((todo, index) => {
    const title = (todo && (todo.content || todo.activeForm)) || '';
    const key = normalizeTitle(title);
    const nth = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, nth);
    return { index, title, nth, status: normalizeStatus(todo && todo.status) };
  });

  // Exact content match first, so a reword cannot steal a task that is still
  // present verbatim.
  const pending = [];
  for (const item of incoming) {
    const id = `todo:${fingerprint(normalizeTitle(item.title))}${item.nth > 1 ? `#${item.nth}` : ''}`;
    if (unmatchedPrevious.has(id)) {
      unmatchedPrevious.delete(id);
      events.push({ taskId: id, title: item.title, status: item.status, matchedBy: 'exact' });
    } else {
      pending.push({ ...item, id });
    }
  }

  for (const item of pending) {
    let matched = null;
    for (const [id, prior] of unmatchedPrevious) {
      if (looksReworded(prior.title, item.title)) {
        matched = { id, prior };
        break;
      }
    }
    if (matched) {
      unmatchedPrevious.delete(matched.id);
      // Keep the original id so the duration survives the reword.
      events.push({ taskId: matched.id, title: item.title, status: item.status, matchedBy: 'fuzzy' });
    } else {
      events.push({ taskId: item.id, title: item.title, status: item.status, matchedBy: 'exact' });
    }
  }

  for (const [id, prior] of unmatchedPrevious) {
    events.push({ taskId: id, title: prior.title, status: 'dropped', matchedBy: prior.matchedBy || 'exact' });
  }

  return events;
}

/**
 * Record what one tool call said about the task list.
 *
 * Called from PostToolBatch with the raw input, before digest.js flattens it —
 * that is the only place the unflattened list exists.
 */
function observe(sessionId, { toolName, input, result, turnIndex = 0, now = Date.now() } = {}) {
  const ts = new Date(now).toISOString();
  const base = { ts, turnIndex };
  const emitted = [];

  const push = (event) => {
    const record = { ...base, ...event, status: normalizeStatus(event.status) };
    append(sessionId, record);
    emitted.push(record);
  };

  if (toolName === 'TaskCreate') {
    // The id is in the result prose, not the input. This is the one place this
    // path can silently stop working, so a result that does not carry an id
    // records nothing rather than inventing one.
    const id = idFromCreateResult(result);
    if (!id) return [];
    push({ taskId: `task:${id}`, title: (input && input.subject) || null, status: 'pending', matchedBy: 'id', event: 'create' });
    return emitted;
  }

  if (toolName === 'TaskUpdate') {
    const id = input && input.taskId != null ? String(input.taskId) : null;
    if (!id) return [];
    const status = input && input.status ? normalizeStatus(input.status) : null;
    // An update that only renames or reassigns carries no status; it still
    // matters, because the title is what a later reader recognises.
    push({
      taskId: `task:${id}`,
      title: (input && input.subject) || null,
      status: status || 'pending',
      matchedBy: 'id',
      event: status ? 'status' : 'edit',
      ...(status ? {} : { statusUnchanged: true }),
    });
    return emitted;
  }

  if (toolName === 'TodoWrite') {
    const todos = input && Array.isArray(input.todos) ? input.todos : null;
    if (!todos) return [];
    const previous = reduceEvents(events(sessionId)).filter(
      (t) => t.status !== 'dropped' && t.taskId.startsWith('todo:'),
    );
    for (const event of diffTodos(previous, todos)) push({ ...event, event: 'list' });
    return emitted;
  }

  return [];
}

/**
 * An update with no status must not reset a task to pending. Applied on read so
 * the ledger itself stays a faithful record of what each call said.
 */
function events(sessionId) {
  const raw = read(sessionId);
  const out = [];
  const lastStatus = new Map();
  for (const record of raw) {
    if (record.statusUnchanged && lastStatus.has(record.taskId)) {
      out.push({ ...record, status: lastStatus.get(record.taskId) });
      continue;
    }
    lastStatus.set(record.taskId, normalizeStatus(record.status));
    out.push(record);
  }
  return out;
}

module.exports = {
  REWORD_OVERLAP,
  STATUSES,
  diffTodos,
  events,
  idFromCreateResult,
  looksReworded,
  normalizeStatus,
  normalizeTitle,
  observe,
  overlap,
  read,
  reduceEvents,
  state,
  tasksFile,
};
