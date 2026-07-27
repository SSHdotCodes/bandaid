#!/usr/bin/env node
'use strict';

/**
 * The detached child that runs one probe.
 *
 * Spawned by the Stop hook and outliving it, which is what lets a ninety-second
 * probe coexist with a hook that has fifteen. It is Bandaid itself rather than
 * a shell wrapper so the result is written by the same atomic writer, truncated
 * by the same rule, and guarded by the same recursion check as everything else.
 *
 * It never throws: a runner that dies loudly leaves a lock and no result, which
 * reads to the next Stop as a probe still in flight. Dying quietly and writing
 * a failure is the honest outcome.
 */

const goalsStore = require('./store');
const probes = require('./probes');
const { loadConfig } = require('./config');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    flags[key] = next && !next.startsWith('--') ? argv[(i += 1)] : true;
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const id = typeof flags.probe === 'string' ? flags.probe : null;
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const stampFp = typeof flags.stamp === 'string' && flags.stamp ? flags.stamp : null;
  const sessionId = typeof flags.session === 'string' ? flags.session : null;

  if (!id) return;

  const config = loadConfig();
  const manifest = probes.loadManifest(cwd, config);
  const probe = manifest && manifest.probes.find((p) => p.id === id);
  if (!probe) {
    probes.releaseLock(cwd, id);
    return;
  }

  // The goal is read rather than passed so the probe sees the objective and
  // criteria as they are now, not as they were when the hook fired.
  const goal = sessionId ? goalsStore.readGoal(sessionId) : null;

  let result;
  try {
    result = probes.runProbe(probe, { cwd, goal, config, stampFp });
  } catch (err) {
    result = {
      probeId: id,
      verdict: 'fail',
      exitCode: null,
      stamp: stampFp,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: `probe runner failed: ${String((err && err.message) || err)}`,
      findings: [],
      artifacts: [],
      output: '',
    };
  }

  try {
    probes.writeCache(cwd, id, result);
  } catch {
    /* the next run will try again */
  } finally {
    probes.releaseLock(cwd, id);
  }
}

try {
  main();
} catch {
  // Nothing here is worth a non-zero exit: this process has no caller waiting.
}
