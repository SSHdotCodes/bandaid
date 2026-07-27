'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const project = require('./project');
const store = require('./store');
const trust = require('./trust');
const { changedPaths, worktreeStamp } = require('./stamp');

/**
 * Probes: verification that takes longer than a hook and can decline to answer.
 *
 * The existing `check` is one shell command, boolean, synchronous, and unable
 * to say "not applicable here". That is enough for `npm test` and not enough
 * for the things that actually decide whether multi-day work landed — a browser
 * at four viewport widths, a minute of sustained load, a scanner that needs a
 * lockfile this project does not have.
 *
 * One rule shapes everything below:
 *
 *     Probes veto. They never prove.
 *
 * A browser probe passing does not prove "migrate auth off JWT"; it proves the
 * page renders. So a probe can block a stop and feed the judge, and only
 * `check` and `judge` can close a goal. Three things fall out of that, all
 * good: a misconfigured probe cannot close a goal early, which is the expensive
 * error; composition needs no weights, because any-veto is the rule `check`
 * already uses; and autonomy needs no new tier, because a probe makes the loop
 * safer rather than longer.
 */

const MANIFEST_PATH = '.bandaid/probes.json';

/** Exit statuses. 78 is EX_CONFIG from sysexits.h. */
const EXIT_ABSTAIN = 78;

const DEFAULT_TIMEOUT_MS = 600000;

/**
 * Probes Bandaid ships, referenced by name so the manifest stays portable.
 *
 * Both are zero-dependency by design: `"dependencies": {}` is a feature, and a
 * probe that needs an install is a probe most projects will not run.
 */
const BUILTINS = {
  secrets: path.join(__dirname, '..', 'probes', 'secrets.js'),
  load: path.join(__dirname, '..', 'probes', 'load.js'),
  sweep: path.join(__dirname, '..', 'probes', 'sweep.js'),
};

// --- manifest ------------------------------------------------------------

function manifestPath(cwd, config) {
  const rel = ((config && config.probes) || {}).manifest || MANIFEST_PATH;
  return path.join(project.projectRoot(cwd), rel);
}

/**
 * Read and validate the project's manifest. Returns null when there is none.
 *
 * Validation is deliberately shallow: a probe with no `id` or no `run` is
 * dropped and everything else is left alone, because a manifest is a contract
 * with a project Bandaid did not write and rejecting the whole file over one
 * unknown key would be the wrong trade.
 */
function loadManifest(cwd, config) {
  const file = manifestPath(cwd, config);
  const raw = store.readJson(file);
  if (!raw || typeof raw !== 'object') return null;

  const list = Array.isArray(raw.probes) ? raw.probes : [];
  const seen = new Set();
  const probes = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim();
    // A builtin resolves to a script Bandaid ships, so a committed manifest
    // carries no machine-specific path and a fix to the probe reaches every
    // project that uses it. `run` still wins when both are given.
    const builtin = BUILTINS[String(entry.builtin || '').trim()] || null;
    const run = String(entry.run || '').trim() || (builtin ? `${JSON.stringify(process.execPath)} ${JSON.stringify(builtin)}` : '');
    if (!id || !run || seen.has(id)) continue;
    seen.add(id);
    probes.push({
      id,
      run,
      description: entry.description ? String(entry.description) : null,
      when: entry.when && typeof entry.when === 'object' ? entry.when : null,
      timeoutMs: Number.isFinite(entry.timeoutMs) ? entry.timeoutMs : null,
      artifacts: entry.artifacts ? String(entry.artifacts) : null,
      summons: entry.summons ? String(entry.summons) : null,
    });
  }

  return { file, probes };
}

// --- glob matching -------------------------------------------------------

/**
 * ponytail: `**`, `*` and `?` only, which is what `when.changed` needs and
 * nothing more. A manifest that wants logic writes it in its probe script,
 * where it is testable and where the probe can exit 78 for itself. The upgrade
 * path is a real matcher, and the reason not to take it is that a condition
 * language in a config file is a permanent support burden.
 */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans directories including none at all.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

function matchesAny(pathname, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(pathname));
}

/**
 * Narrow a probe set to the ones this goal's changes could possibly affect.
 *
 * `changed` of null means "cannot tell" — no git, or no base commit — and every
 * probe applies, because skipping a verifier on a guess is the wrong direction
 * to be wrong in.
 */
function applicable(probes, changed) {
  if (changed == null) return probes;
  return probes.filter((probe) => {
    const patterns = probe.when && Array.isArray(probe.when.changed) ? probe.when.changed : null;
    if (!patterns || !patterns.length) return true;
    return changed.some((file) => matchesAny(file, patterns));
  });
}

/**
 * The probes armed for a goal: the manifest, narrowed to the set frozen onto
 * the goal when it was set.
 *
 * Freezing follows the same discipline as `criteria` and `maxContinuations` —
 * a probe added to the manifest mid-goal does not retroactively move the bar.
 * A goal with no frozen list predates the feature and takes the manifest as it
 * stands, so adding a manifest to an existing project works without resetting
 * the objective.
 *
 * Executes nothing: this is called from the stop decision, which must stay
 * fast and pure.
 */
function trustedProbes(config, goal, cwd) {
  if (((config && config.probes) || {}).enabled === false) return [];

  const root = (goal && goal.projectRoot) || cwd;
  if (!root) return [];

  const manifest = loadManifest(root, config);
  if (!manifest || !manifest.probes.length) return [];
  if (!trust.isTrusted(root, manifest.file)) return [];

  const frozen = goal && Array.isArray(goal.probes) ? goal.probes : null;
  return frozen ? manifest.probes.filter((p) => frozen.includes(p.id)) : manifest.probes;
}

// --- cache and locks -----------------------------------------------------

function probesDir(cwd) {
  return path.join(project.projectDir(cwd), 'probes');
}

function cacheFile(cwd, id) {
  return path.join(probesDir(cwd), `${id}.json`);
}

function lockFile(cwd, id) {
  return path.join(probesDir(cwd), `${id}.lock`);
}

function readCache(cwd, id) {
  return store.readJson(cacheFile(cwd, id));
}

function writeCache(cwd, id, result) {
  store.writeJson(cacheFile(cwd, id), result);
  return result;
}

function clearCache(cwd, id = null) {
  try {
    if (id) {
      fs.rmSync(cacheFile(cwd, id), { force: true });
      fs.rmSync(lockFile(cwd, id), { force: true });
      return;
    }
    fs.rmSync(probesDir(cwd), { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * `{ held, record }`. A lock whose process is gone, or that has outlived the
 * probe's own budget by a minute, is stale and may be broken — the worst case
 * of getting that wrong is one duplicated probe run.
 */
function lockState(cwd, id, timeoutMs) {
  const record = store.readJson(lockFile(cwd, id));
  if (!record) return { held: false, record: null };

  const started = Date.parse(record.startedAt || '');
  const expired = Number.isFinite(started) && Date.now() - started > timeoutMs + 60000;
  if (expired || !processAlive(record.pid)) return { held: false, record };

  return { held: true, record };
}

function takeLock(cwd, id, stampFp) {
  store.writeJson(lockFile(cwd, id), { pid: process.pid, stamp: stampFp, startedAt: new Date().toISOString() });
}

function releaseLock(cwd, id) {
  try {
    fs.rmSync(lockFile(cwd, id), { force: true });
  } catch {
    /* already gone */
  }
}

// --- running -------------------------------------------------------------

function verdictFromExit(status, signal) {
  if (signal) return 'fail';
  if (status === 0) return 'pass';
  if (status === EXIT_ABSTAIN) return 'abstain';
  return 'fail';
}

/** The last line of stdout, if it happens to be JSON. Never changes the verdict. */
function parseDetail(stdout) {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not the structured line */
    }
  }
  return null;
}

function tail(text, limit = 2000) {
  const trimmed = String(text == null ? '' : text).trim();
  if (trimmed.length <= limit) return trimmed;
  return `…(earlier output trimmed)\n${trimmed.slice(-limit)}`;
}

function probeEnv(probe, { goal, stampFp, artifactDir }) {
  return {
    ...process.env,
    // A probe must never recurse into the thing that launched it.
    BANDAID_ENABLED: '0',
    BANDAID_PROBE: probe.id,
    BANDAID_OBJECTIVE: (goal && goal.objective) || '',
    BANDAID_CRITERIA: ((goal && goal.criteria) || []).join('\n'),
    BANDAID_ARTIFACT_DIR: artifactDir || '',
    BANDAID_STAMP: stampFp || '',
    BANDAID_BASE_SHA: (goal && goal.baseSha) || '',
  };
}

function artifactDirFor(cwd, probe, config) {
  const root = ((config && config.probes) || {}).artifactRoot || '.bandaid/artifacts';
  const dir = path.join(project.projectRoot(cwd), probe.artifacts || path.join(root, probe.id));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}

/**
 * Run one probe to completion. Used by `--wait` and by the detached runner.
 *
 * Exit status is the verdict and stdout is never read as one: a probe printing
 * `{"ok":true}` and exiting 1 has failed. The one case where Bandaid decides
 * rather than the probe is a binary it could not start at all, which abstains
 * loudly — one broken manifest entry must not wedge every goal in the repo.
 */
function runProbe(probe, { cwd, goal = null, config = {}, stampFp = null } = {}) {
  const root = project.projectRoot(cwd);
  const timeoutMs = probe.timeoutMs || ((config.probes || {}).defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const artifactDir = artifactDirFor(cwd, probe, config);
  const startedAt = new Date().toISOString();

  const result = spawnSync(probe.run, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: probeEnv(probe, { goal, stampFp, artifactDir }),
  });

  const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'));
  const detail = parseDetail(result.stdout);

  let verdict;
  let note = null;
  if (result.error) {
    const code = result.error.code;
    if (code === 'ENOENT' || code === 'EACCES') {
      verdict = 'abstain';
      note = `probe could not be started: ${result.error.message}`;
    } else if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
      verdict = 'fail';
      note = `probe exceeded its ${timeoutMs}ms budget`;
    } else {
      verdict = 'fail';
      note = String(result.error.message || result.error);
    }
  } else {
    verdict = verdictFromExit(result.status, result.signal);
  }

  return {
    probeId: probe.id,
    verdict,
    exitCode: result.status ?? null,
    stamp: stampFp,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: (detail && detail.summary) || note || firstLine(output) || null,
    findings: (detail && Array.isArray(detail.findings) && detail.findings) || [],
    artifacts: (detail && Array.isArray(detail.artifacts) && detail.artifacts) || [],
    metrics: (detail && detail.metrics) || null,
    summons: probe.summons || null,
    output,
  };
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim());
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Start a probe and walk away.
 *
 * The child outlives the hook that started it, which is what makes a
 * ninety-second probe compatible with a fifteen-second budget. The continuation
 * loop is already the scheduler: Bandaid blocks and re-enters anyway, so the
 * probe only has to survive one continuation, which it does for free.
 */
function launchDetached(probe, { cwd, goal, stampFp }) {
  const runner = path.join(__dirname, 'probe-runner.js');
  const root = project.projectRoot(cwd);

  try {
    takeLock(root, probe.id, stampFp);
    const child = spawn(
      process.execPath,
      [runner, '--probe', probe.id, '--cwd', root, '--stamp', stampFp || ''],
      { detached: true, stdio: 'ignore', cwd: root, env: { ...process.env, BANDAID_ENABLED: '0' } },
    );
    child.unref();
    return { pid: child.pid };
  } catch (err) {
    releaseLock(root, probe.id);
    return { pid: null, error: String(err && err.message) };
  }
}

// --- composition ---------------------------------------------------------

/**
 * Any-veto, and nothing else.
 *
 * A weighted composition would be a knob nobody can calibrate, non-reproducible
 * between runs, and a model's opinion wearing a number. An abstaining probe is
 * invisible: byte-identical to the probe not existing, which is the property
 * the whole abstain path exists to provide.
 */
function composeProbes(results) {
  const failures = results.filter((r) => r.verdict === 'fail');
  const pending = results.filter((r) => r.verdict === 'pending');
  const abstained = results.filter((r) => r.verdict === 'abstain');
  const passed = results.filter((r) => r.verdict === 'pass');

  let verdict = 'abstain';
  if (failures.length) verdict = 'fail';
  else if (passed.length) verdict = 'pass';

  return {
    verdict,
    failures,
    pending,
    abstained,
    passed,
    summonses: [...new Set(abstained.map((r) => r.summons).filter(Boolean))],
  };
}

/**
 * Look at every applicable probe, using cached verdicts where they still
 * describe this worktree and launching the ones that do not.
 *
 * Never blocks: a probe with no current answer comes back `pending`, which
 * cannot veto. Deciding what to do about that belongs to the Stop hook.
 */
function assessProbes({ goal, config = {}, cwd, launch = true } = {}) {
  const root = (goal && goal.projectRoot) || cwd;
  if (!root) return { verdict: 'abstain', failures: [], pending: [], abstained: [], passed: [], summonses: [], results: [] };

  const probes = applicable(trustedProbes(config, goal, root), changedPaths(root, goal && goal.baseSha));
  if (!probes.length) {
    return { verdict: 'abstain', failures: [], pending: [], abstained: [], passed: [], summonses: [], results: [] };
  }

  const stamp = worktreeStamp(root);
  const results = [];

  for (const probe of probes) {
    const cached = readCache(root, probe.id);
    if (cached && cached.finishedAt && stamp.fp && cached.stamp === stamp.fp) {
      results.push(cached);
      continue;
    }

    const timeoutMs = probe.timeoutMs || ((config.probes || {}).defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const lock = lockState(root, probe.id, timeoutMs);

    if (!lock.held && launch) launchDetached(probe, { cwd: root, goal, stampFp: stamp.fp });

    results.push({
      probeId: probe.id,
      verdict: 'pending',
      stamp: stamp.fp,
      startedAt: lock.record ? lock.record.startedAt : new Date().toISOString(),
      summary: null,
      summons: probe.summons || null,
      timeoutMs,
    });
  }

  return { ...composeProbes(results), results, stamp };
}

/** For `bandaid probe status`, which wants the picture rather than a verdict. */
function probeStatus({ goal, config = {}, cwd }) {
  const root = (goal && goal.projectRoot) || cwd;
  const manifest = loadManifest(root, config);
  const stamp = worktreeStamp(root);
  const changed = changedPaths(root, goal && goal.baseSha);
  const armed = trustedProbes(config, goal, root);
  const armedIds = new Set(armed.map((p) => p.id));
  const applicableIds = new Set(applicable(armed, changed).map((p) => p.id));

  return (manifest ? manifest.probes : []).map((probe) => {
    const cached = readCache(root, probe.id);
    const fresh = Boolean(cached && cached.finishedAt && stamp.fp && cached.stamp === stamp.fp);
    const lock = lockState(root, probe.id, probe.timeoutMs || DEFAULT_TIMEOUT_MS);
    return {
      id: probe.id,
      description: probe.description,
      armed: armedIds.has(probe.id),
      applicable: applicableIds.has(probe.id),
      running: lock.held,
      verdict: fresh ? cached.verdict : cached ? 'stale' : 'none',
      summary: cached ? cached.summary : null,
      finishedAt: cached ? cached.finishedAt : null,
    };
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  EXIT_ABSTAIN,
  MANIFEST_PATH,
  applicable,
  artifactDirFor,
  assessProbes,
  cacheFile,
  clearCache,
  composeProbes,
  globToRegExp,
  launchDetached,
  loadManifest,
  lockFile,
  lockState,
  manifestPath,
  parseDetail,
  probeStatus,
  readCache,
  releaseLock,
  runProbe,
  takeLock,
  trustedProbes,
  verdictFromExit,
  writeCache,
};
