#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');
const goals = require('../src/lib/goals');
const install = require('../src/lib/install');
const ledger = require('../src/lib/ledger');
const project = require('../src/lib/project');
const store = require('../src/lib/store');
const verify = require('../src/lib/verify');
const { buildRestoreBlock } = require('../src/lib/restore');
const { COMPACTION_FIDELITY_ADDENDUM, SUMMARIZATION_PROMPT } = require('../src/lib/prompts');
const { formatBudget, formatDuration, parseDuration, timeUsedMs } = require('../src/lib/duration');

const pkg = require('../package.json');

// `bandaid tasks | head -4` closes the pipe while we are still writing, and an
// unhandled EPIPE turns a normal shell idiom into a stack trace. Exiting quietly
// is what every other CLI does here.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

function out(text = '') {
  process.stdout.write(`${text}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`bandaid: ${message}\n`);
  process.exitCode = code;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      let value;
      if (inline !== undefined) value = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) value = argv[(i += 1)];
      else value = true;

      // A flag given twice accumulates rather than overwriting, so
      // `--pointer a --pointer b` means both. Given once it stays a scalar, so
      // every existing caller reads exactly what it always did.
      if (key in flags) flags[key] = [].concat(flags[key], value);
      else flags[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function resolveSession(flags) {
  const explicit = flags.session && typeof flags.session === 'string' ? store.sanitizeId(flags.session) : null;
  if (explicit) return explicit;
  const current = store.getCurrentSession(flags.cwd || process.cwd());
  if (current) return current;
  return null;
}

/**
 * Commands that change a goal must not guess which session they mean.
 *
 * Two Claude Code sessions in one directory both drop a pointer here. Without
 * `--session` the CLI would take whichever prompted most recently, so
 * `goal complete` in one session could close the other's objective — reported
 * behaviour, and adopting an objective makes it worse rather than better.
 * Returns true when the caller should stop.
 */
function refuseIfAmbiguous(flags) {
  if (flags.session) return false;
  if (store.sanitizeId(process.env.CLAUDE_SESSION_ID)) return false;

  const recent = store.ambiguousSessions(flags.cwd || process.cwd());
  if (recent.length < 2) return false;

  fail(`${recent.length} sessions are active in this directory; pass --session <id> to say which you mean`);
  for (const entry of recent) process.stderr.write(`  ${entry.sessionId}  last prompt ${entry.ts}\n`);
  return true;
}

const USAGE = `bandaid ${pkg.version} — Codex-style compaction and goals for Claude Code

Usage: bandaid <command> [options]

  status                     Show config, install state, and the live session
  doctor                     Check that the environment supports every hook
  install [--scope user|project|local]
                             Wire hooks into settings.json (plugin install is preferred)
  uninstall [--scope ...]    Remove hooks Bandaid added
  on | off                   Enable or disable Bandaid without uninstalling

  goal show                  Print the active objective
  goal set <objective>       Set the objective explicitly
      --check "<command>"    Close the goal automatically when this exits 0
      --seal "<command>"     A held-out check, run only when the goal is about to
                             close. Neither it nor its output is shown to the model
      --budget <tokens>      Stop continuing after roughly this many tokens
      --time-budget <dur>    Wrap up after this much wall-clock (90m, 2h, 1h30m)
      --probe <id>           Arm a specific probe (repeatable; default is the manifest)
      --scope <glob>         Declare a path this goal may touch (repeatable)
  goal criteria [<c> ...]    Record the fixed acceptance criteria, or list them
      --derive               Have a separate reader write them instead, from the
                             objective and the repo. Falls back to <c> if it cannot
      --replace              Overwrite criteria that were already fixed
  goal block <reason>        Record something this environment cannot do, and keep going
  goal complete [note]       Mark the objective achieved (this is what the model calls)
  goal blocked [note]        Mark the whole objective blocked and stop
  goal adopt | goal resume   Take up the objective this project left open
  goal history               Show the project's open objective and its sessions
  goal clear [--project]     Drop the session's objective, or the project's record
  goal expect <cmd>          Record a prediction now: --says <output>, or --file/--contains
  goal scope <glob>...       Declare the paths this goal may touch
  verify                     Run the check command and the judge now, and report
  self-check                 Which criteria have measured evidence, and which do not

  probes list                The project's probe manifest and its trust state
  probes trust [--yes]       Approve the manifest's exact contents so it may run
  probes untrust             Withdraw approval
  probe status               What each probe last said about this worktree
  probe run <id>             Run one now and cache the verdict
  probe arm|disarm <id>      Change which probes this goal is graded by
  probe clear [<id>]         Drop cached verdicts

  evidence show              The claims-with-pointers ledger for this objective
  evidence add <claim>       Record something you established (always unverified)
      --criterion N          Which acceptance criterion it bears on
      --pointer <ref>        Where to check it: file.js:12, or "cmd:npm test"

  inspect [--session ID]     Summarize the ledger for a session
  durations                  What this project's tools cost, as p50/p95
                             [--transcript <path>] [--json]
  tasks [--session ID]       The task list this session worked, with durations
  preview [--session ID]     Print exactly what would be injected after a compaction
  prompt                     Print the compaction prompt Bandaid installs
  sessions                   List sessions with a ledger
  sessions prune             Delete old session dirs (never one with an active goal)
                             [--older-than <days>] [--keep <n>] [--dry-run]

Options:
  --session ID    Target a specific session (defaults to the live one)
  --json          Machine-readable output where supported
`;

// --- commands ------------------------------------------------------------

function cmdStatus(flags) {
  const cfg = config.loadConfig({ reload: true });
  const sessionId = resolveSession(flags);
  const installed = install.installedEvents({ scope: flags.scope || 'user' });

  if (flags.json) {
    out(JSON.stringify({ version: pkg.version, config: cfg, sessionId, settingsHooks: installed }, null, 2));
    return;
  }

  out(`bandaid ${pkg.version}`);
  out(`  enabled:        ${cfg.enabled ? 'yes' : 'no'}`);
  out(`  compaction:     ${cfg.compact.enabled ? 'on' : 'off'} (verbatim budget ${cfg.compact.userMessageMaxTokens} tokens, digests ${cfg.compact.digestBudgetTokens} tokens)`);
  out(`  goals:          ${cfg.goals.enabled ? cfg.goals.mode : 'off'} (max ${goals.resolveMaxContinuations(cfg)} continuation(s) per goal, ${goals.verifierStrength(cfg)})`);
  out(
    `  budgets:        tokens ${cfg.goals.tokenBudget ?? 'unbounded'}, wall-clock ${
      cfg.goals.timeBudgetMs ? formatBudget(cfg.goals.timeBudgetMs) : 'unbounded'
    }`,
  );
  out(`  verification:   check ${cfg.goals.check ? `\`${cfg.goals.check}\`` : 'unset'}, judge ${cfg.goals.judge ? `on (${cfg.goals.judgeModel})` : 'off'}`);
  out(`  config file:    ${config.configPath()}`);
  out(`  state dir:      ${config.homeDir()}`);
  out(`  settings hooks: ${installed.length ? installed.join(', ') : 'none (plugin install, or not installed)'}`);

  if (!sessionId) {
    out('  session:        none seen yet in this directory');
    return;
  }

  const prompts = store.readPrompts(sessionId);
  const turns = store.readTurns(sessionId);
  const goal = goals.loadGoal(sessionId);
  out(`  session:        ${sessionId}`);
  out(`  ledger:         ${prompts.length} prompt(s), ${turns.length} tool batch(es)`);
  out(`  goal:           ${goal ? `[${goal.status}] ${goal.objective.split('\n')[0].slice(0, 70)}` : 'none'}`);
}

function cmdDoctor(flags) {
  const problems = [];
  const notes = [];

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) problems.push(`Node ${process.versions.node} is too old; Bandaid needs Node 18+`);
  else notes.push(`Node ${process.versions.node}`);

  try {
    const dir = config.homeDir();
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    notes.push(`state dir writable (${dir})`);
  } catch (err) {
    problems.push(`state dir is not writable: ${err.message}`);
  }

  for (const spec of install.HOOK_EVENTS) {
    const file = path.join(install.repoRoot(), 'src', 'hooks', spec.file);
    if (!fs.existsSync(file)) problems.push(`missing hook script ${file}`);
  }
  if (!problems.length) notes.push(`${install.HOOK_EVENTS.length} hook scripts present`);

  const installed = install.installedEvents({ scope: flags.scope || 'user' });
  if (installed.length && installed.length < install.HOOK_EVENTS.length) {
    problems.push(`settings.json has only ${installed.length}/${install.HOOK_EVENTS.length} Bandaid hooks; re-run "bandaid install"`);
  }

  // The Stop hook's budget and the verifier's budget live in different files,
  // and a user who raises one will not think about the other. When the hook is
  // the tighter of the two, Claude Code kills the verdict mid-flight — and a
  // killed hook is not exit 2, so the stop goes through unverified. That is the
  // one failure this whole loop must not have, so it is worth naming here.
  const stopHook = install.HOOK_EVENTS.find((spec) => spec.event === 'Stop');
  const verifyMs = config.loadConfig().goals.verifyTimeoutMs ?? verify.DEFAULT_TIMEOUT_MS;
  if (stopHook && stopHook.timeout * 1000 <= verifyMs) {
    problems.push(
      `Stop hook timeout (${stopHook.timeout}s) does not clear goals.verifyTimeoutMs (${Math.round(verifyMs / 1000)}s); a slow verifier will be killed and the stop will go through unverified`,
    );
  } else if (stopHook) {
    notes.push(`Stop budget ${stopHook.timeout}s clears verifyTimeoutMs ${Math.round(verifyMs / 1000)}s`);
  }

  // "Why did my goal not carry over?" is usually "you are in a different
  // worktree than you think", and this is the only place that answer lives.
  const cwd = flags.cwd || process.cwd();
  const root = project.projectRoot(cwd);
  notes.push(`project ${root} (${project.projectKey(cwd)})${root === cwd ? '' : ` from ${cwd}`}`);
  const handoff = project.readHandoff(cwd);
  if (handoff && handoff.goal.status === 'active') {
    notes.push(`open objective recorded, last worked ${project.ageInDays(handoff.updatedAt)} day(s) ago`);
  }

  for (const note of notes) out(`  ok    ${note}`);
  for (const problem of problems) out(`  FAIL  ${problem}`);
  if (problems.length) process.exitCode = 1;
  else out('\nAll checks passed.');
}

function cmdInstall(flags) {
  const { file, added } = install.install({ scope: flags.scope || 'user' });
  out(`Installed ${added.length} hooks into ${file}`);
  out(`  ${added.join(', ')}`);
  out('\nRestart Claude Code (or run /hooks) for the change to take effect.');
}

function cmdUninstall(flags) {
  const { file, removed } = install.uninstall({ scope: flags.scope || 'user' });
  if (!removed.length) out(`No Bandaid hooks found in ${file}`);
  else out(`Removed ${removed.length} hooks from ${file}: ${removed.join(', ')}`);
}

function cmdToggle(enabled) {
  config.saveConfig({ enabled });
  out(`bandaid is now ${enabled ? 'enabled' : 'disabled'} (${config.configPath()})`);
}

// Reads are fine to guess at; writes are not.
const GOAL_WRITES = new Set([
  'set', 'criteria', 'complete', 'done', 'block', 'blocked', 'clear', 'adopt', 'resume', 'expect', 'scope',
]);

/** The project's own record, independent of whatever session is running. */
function cmdGoalProject(sub, flags) {
  const cwd = flags.cwd || process.cwd();

  if (sub === 'clear') {
    project.clearHandoff(cwd);
    out('Project objective cleared. The session goal, if any, is untouched.');
    return;
  }

  const record = project.readHandoff(cwd);
  if (!record) {
    out('No open objective recorded for this project.');
    return;
  }
  if (flags.json) {
    out(JSON.stringify(record, null, 2));
    return;
  }
  out(`project:  ${record.projectRoot}`);
  out(`updated:  ${record.updatedAt} (${project.ageInDays(record.updatedAt)} day(s) ago)`);
  out(`status:   ${record.goal.status}`);
  out(`criteria: ${(record.goal.criteria || []).length}`);
  out(`sessions: ${(record.goal.sessions || []).length}`);
  for (const id of record.goal.sessions || []) out(`  ${id}`);
  out('');
  out(record.goal.objective);
}

function cmdGoal(positional, flags) {
  const [sub, ...rest] = positional;

  // Project-scoped operations do not belong to any session, so they neither
  // need one resolved nor care that two are running here.
  if (sub === 'history' || (sub === 'clear' && flags.project)) {
    return cmdGoalProject(sub, flags);
  }

  if (GOAL_WRITES.has(sub || '') && refuseIfAmbiguous(flags)) return;

  const sessionId = resolveSession(flags);

  if (!sessionId) {
    fail('no session found. Pass --session <id>, or run this from a Claude Code session.');
    return;
  }

  switch (sub || 'show') {
    case 'show': {
      const goal = goals.loadGoal(sessionId);
      if (flags.json) {
        out(JSON.stringify(goal, null, 2));
        return;
      }
      if (!goal) {
        out('No active goal.');
        return;
      }
      out(`status:        ${goal.status}`);
      out(`source:        ${goal.source}`);
      out(`continuations: ${goal.continuations}/${goal.maxContinuations ?? '∞'}`);
      out(`tokens used:   ~${goal.tokensUsed}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ''}`);
      // Elapsed is measured, unlike the token figure above it, which sums already
      // truncated digests and is a floor. Worth showing side by side so the
      // difference in quality is visible.
      const elapsed = timeUsedMs(goal);
      const timeBudget = goal.timeBudgetMs ?? config.loadConfig().goals.timeBudgetMs ?? null;
      if (elapsed != null) {
        out(`elapsed:       ${formatDuration(elapsed)}${timeBudget ? ` / ${formatBudget(timeBudget)}` : ''}`);
      }
      // An estimate, marked as one. It sits under two measured figures, and
      // rendering all three with equal confidence is how a useful signal becomes
      // a misleading one.
      const est = goalEstimate(sessionId, goal);
      if (est) {
        const range =
          est.lowMs == null || est.highMs == null
            ? ''
            : ` (range ${formatDuration(est.lowMs)}–${formatDuration(est.highMs)})`;
        out(
          `eta:           ~${formatDuration(est.remainingMs)} remaining${range}` +
            `  [${est.unitsRemaining} ${est.basis === 'tasks' ? 'task' : 'round'}(s) left, n=${est.n}]`,
        );
      }
      const effectiveCheck = goal.check ?? config.loadConfig().goals.check;
      out(`check:         ${effectiveCheck || 'none'}`);
      const effectiveSeal = goal.seal ?? config.loadConfig().goals.seal;
      if (effectiveSeal) out(`seal:          ${effectiveSeal}  (held out — never shown to the model)`);
      const criteria = goal.criteria || [];
      out(`criteria:      ${criteria.length ? `${criteria.length} (${goal.criteriaSource || 'unknown'})` : 'none recorded'}`);
      for (const [i, text] of criteria.entries()) out(`  ${i + 1}. ${text}`);
      const constraints = goal.constraints || [];
      if (constraints.length) {
        out(`constraints:   ${constraints.length} (from the objective)`);
        for (const text of constraints) out(`  - ${text}`);
      }
      const blockers = goal.blockers || [];
      if (blockers.length) {
        const limit = config.loadConfig().goals.blockerLimit ?? goals.DEFAULT_BLOCKER_LIMIT;
        out(`blockers:      ${blockers.length} (${goal.blockedStreak || 0}/${limit} toward stopping)`);
        for (const [i, text] of blockers.entries()) out(`  ${i + 1}. ${text}`);
      }
      if (goal.lastReason) out(`last verdict:  ${goal.lastReason}${goal.plateau ? ` (repeated ${goal.plateau}x)` : ''}`);
      if (goal.note) out(`note:          ${goal.note}`);
      // The one place the seal's finding is rendered. This is the reader it was
      // withheld from the model for.
      if (goal.sealFailure) {
        out('');
        out(`held-out check refused the close at ${goal.sealFailure.at}`);
        if (goal.sealFailure.command) out(`  command: ${goal.sealFailure.command}`);
        if (goal.sealFailure.output) {
          for (const line of String(goal.sealFailure.output).split('\n')) out(`  ${line}`);
        }
      }
      out('');
      out(goal.objective);
      return;
    }
    case 'set': {
      const objective = rest.join(' ').trim();
      if (!objective) {
        fail('goal set needs an objective');
        return;
      }
      const cfg = config.loadConfig();
      const check = typeof flags.check === 'string' ? flags.check : null;
      const seal = typeof flags.seal === 'string' ? flags.seal : null;
      const cwd = flags.cwd || process.cwd();

      // Rejected rather than guessed: a budget parsed wrongly caps the work at a
      // number nobody chose, and does it silently.
      let timeBudgetMs = null;
      if (flags['time-budget'] !== undefined) {
        timeBudgetMs = parseDuration(flags['time-budget']);
        if (timeBudgetMs == null) {
          fail(`could not read --time-budget "${flags['time-budget']}" — try 90m, 2h, 1h30m, or milliseconds`);
          return;
        }
      }

      // Freeze the armed probe set now, the same discipline criteria follow: a
      // manifest edited mid-goal must not retroactively move the bar. An
      // explicit --probe list wins; otherwise the trusted manifest as it stands.
      const explicitProbes = flags.probe ? [].concat(flags.probe).filter((p) => typeof p === 'string') : null;
      const armed =
        explicitProbes ||
        require('../src/lib/probes')
          .trustedProbes(cfg, { projectRoot: project.projectRoot(cwd) }, cwd)
          .map((p) => p.id);

      goals.setGoal(sessionId, objective, {
        probes: armed.length ? armed : null,
        scope: flags.scope ? [].concat(flags.scope).filter((s) => typeof s === 'string') : [],
        source: 'explicit',
        // Resolved with the check in hand, so `--check` earns the longer leash
        // in the same breath that it supplies the thing doing the verifying.
        //
        // `seal` deliberately does not enter this. It vetoes but never proves —
        // the same reason probes do not earn a longer leash — and it is only
        // reachable on a round something else was already closing, so a goal
        // carrying a seal and nothing else would run it never.
        maxContinuations: flags['max-continuations']
          ? Number(flags['max-continuations'])
          : goals.resolveMaxContinuations(cfg, { check }),
        tokenBudget: flags.budget ? Number(flags.budget) : null,
        timeBudgetMs,
        // Scope the goal to the work that follows it. Without this an explicit
        // goal gets turnIndex 0 and `turnsForGoal` sweeps the whole session, so
        // both the token estimate and the judge's evidence include work that
        // predates the objective.
        turnIndex: ledger.currentTurnIndex(sessionId),
        check,
        seal,
        cwd,
      });
      out(`Goal set for session ${sessionId}.`);
      if (typeof flags.check === 'string') {
        out(`It closes automatically when \`${flags.check}\` exits 0.`);
      }
      if (seal) {
        out(`A held-out check runs before it closes. Bandaid will not show it, or its output, to the model.`);
        if (!check && !cfg.goals.check && !cfg.goals.judge) {
          out(`Note: nothing else can prove this goal, so the held-out check will never run. Add --check or turn the judge on.`);
        }
      }
      if (timeBudgetMs != null) {
        out(`It wraps up after ${formatBudget(timeBudgetMs)} of wall-clock.`);
      }
      return;
    }
    case 'criteria': {
      const goal = goals.loadGoal(sessionId);
      if (!goal) {
        fail('no active goal to attach criteria to');
        return;
      }
      if (!rest.length && !flags.derive) {
        const existing = goal.criteria || [];
        if (!existing.length) out('No criteria recorded.');
        for (const [i, text] of existing.entries()) out(`${i + 1}. ${text}`);
        return;
      }

      // Derived by a process that will not be graded on the result. Falls back to
      // the caller's own list rather than failing: a goal with worker-written
      // criteria is the behaviour that shipped for months, and it is better than a
      // goal with none. What must not happen silently is the provenance going
      // unrecorded, which is why `criteriaSource` distinguishes the two.
      let proposed = rest;
      let source = 'model';
      if (flags.derive) {
        const cfg = config.loadConfig();
        const derived = require('../src/lib/verify').runCriteria({
          objective: goal.objective,
          cwd: goal.projectRoot || flags.cwd || process.cwd(),
          model: cfg.goals.judgeModel || 'haiku',
          cli: cfg.goals.judgeCli || 'claude',
          timeoutMs: cfg.goals.verifyTimeoutMs,
        });
        if (derived && derived.length) {
          proposed = derived;
          source = 'independent';
        } else if (rest.length) {
          out('Could not derive criteria independently; falling back to the list you supplied.');
        } else {
          fail('could not derive criteria independently, and no fallback list was given');
          return;
        }
      }

      const before = (goal.criteria || []).length;
      const updated = goals.setCriteria(sessionId, proposed, {
        source,
        replace: flags.replace === true || flags.replace === 'true',
      });
      if (before && !flags.replace) {
        out(`Criteria already fixed for this goal (${before}); pass --replace to overwrite them.`);
        return;
      }
      out(`Recorded ${updated.criteria.length} acceptance criteria (${updated.criteriaSource}). They are now the bar every turn.`);
      for (const [i, text] of updated.criteria.entries()) out(`  ${i + 1}. ${text}`);
      if (updated.criteriaSource === 'independent') {
        out('');
        out('Written by a separate reader that will not be graded on them. Show them to the user before starting work — if they name the wrong bar, this is the moment to fix it.');
      }
      return;
    }
    case 'complete':
    case 'done': {
      const goal = goals.closeGoal(sessionId, 'complete', rest.join(' ') || null);
      out(goal ? 'Goal marked complete. Bandaid will stop asking about it.' : 'No active goal to complete.');
      return;
    }
    // `block` records one impossible piece and leaves the goal running;
    // `blocked` gives up on the whole objective. Different scopes, deliberately
    // adjacent names, because the model reaches for whichever it means.
    case 'block': {
      const reason = rest.join(' ').trim();
      if (!reason) {
        fail('goal block needs a reason: what is blocked and what would unblock it');
        return;
      }
      const goal = goals.addBlocker(sessionId, reason);
      if (!goal) {
        fail('no active goal to record a blocker against');
        return;
      }
      const limit = config.loadConfig().goals.blockerLimit ?? goals.DEFAULT_BLOCKER_LIMIT;
      out(`Blocker recorded (${goal.blockedStreak}/${limit}). It will not be asked for again.`);
      out(
        goals.blockedOut(goal, config.loadConfig())
          ? 'Enough is blocked that Bandaid will stop continuing this goal. Tell the user what would unblock it.'
          : 'The goal is still active — keep working the parts that are not blocked.',
      );
      return;
    }
    case 'blocked': {
      const goal = goals.closeGoal(sessionId, 'blocked', rest.join(' ') || null);
      out(goal ? 'Goal marked blocked.' : 'No active goal to block.');
      return;
    }
    // Take up an objective this project left open. `resume` is an alias
    // because both words describe it and nobody should have to guess which.
    case 'adopt':
    case 'resume': {
      const cwd = flags.cwd || process.cwd();
      const record = project.readHandoff(cwd);
      if (!record || record.goal.status !== 'active') {
        out('No open objective recorded for this project.');
        return;
      }
      if (goals.loadGoal(sessionId)) {
        fail('this session already has a goal; clear it first if you mean to replace it');
        return;
      }
      const adopted = goals.adoptHandoff(sessionId, cwd, config.loadConfig(), {
        turnIndex: ledger.currentTurnIndex(sessionId),
      });
      if (!adopted) {
        fail('could not adopt the objective');
        return;
      }
      const age = project.ageInDays(record.updatedAt);
      out(`Adopted the objective for ${record.projectRoot}.`);
      out('');
      out(`  ${adopted.objective}`);
      out('');
      out(`  age          ${age === 0 ? 'today' : `${age} day(s)`}, ${(record.goal.sessions || []).length} session(s)`);
      out(`  criteria     ${(adopted.criteria || []).length}`);
      out(`  constraints  ${(adopted.constraints || []).length}`);
      out(`  blockers     ${(adopted.blockers || []).length}`);
      out(`  check        ${adopted.check || config.loadConfig().goals.check || 'none'}`);
      out(`  budget       0/${adopted.maxContinuations} continuations (fresh)`);
      out('');
      out('Verify current state before assuming any of it is already done.');
      return;
    }
    case 'expect': {
      const goal = goals.loadGoal(sessionId);
      if (!goal) {
        fail('no active goal to record an expectation against');
        return;
      }
      const selfcheck = require('../src/lib/selfcheck');
      const command = rest.join(' ').trim() || null;
      const next = selfcheck.addExpectation(goal.expectations, {
        command,
        file: typeof flags.file === 'string' ? flags.file : null,
        says: typeof flags.says === 'string' ? flags.says : null,
        contains: typeof flags.contains === 'string' ? flags.contains : null,
      });
      if (!next) {
        fail('goal expect needs a command, or --file <path> [--contains <text>]');
        return;
      }
      const updated = goals.saveGoal(sessionId, { ...goal, expectations: next });
      out(`Recorded. ${updated.expectations.length} expectation(s) will be run at every stop.`);
      out('If one stops holding, the stop is blocked with what it said instead.');
      return;
    }
    case 'scope': {
      const goal = goals.loadGoal(sessionId);
      if (!goal) {
        fail('no active goal to scope');
        return;
      }
      if (!rest.length) {
        const declared = goal.scope || [];
        if (!declared.length) out('No scope declared; this goal may touch anything.');
        for (const glob of declared) out(`  ${glob}`);
        return;
      }
      const updated = goals.saveGoal(sessionId, { ...goal, scope: rest });
      out(`Scoped to ${updated.scope.length} path pattern(s). Changes anywhere else block the stop.`);
      return;
    }
    case 'clear': {
      store.clearGoal(sessionId);
      out('Goal cleared. The project record survives; pass --project to drop that too.');
      return;
    }
    default:
      fail(`unknown goal subcommand "${sub}"`);
  }
}

/**
 * Run the verification tiers on demand. Without this a failing check is only
 * ever seen by the model, which makes "why does it keep going?" unanswerable.
 */
function cmdVerify(flags) {
  const sessionId = resolveSession(flags);
  if (!sessionId) {
    fail('no session found. Pass --session <id>.');
    return;
  }
  const goal = goals.loadGoal(sessionId);
  if (!goal) {
    out('No active goal to verify.');
    return;
  }

  const cfg = config.loadConfig();
  const result = verify.assess({
    goal,
    config: cfg,
    cwd: flags.cwd || process.cwd(),
    turns: store.readTurns(sessionId),
    record: true,
  });

  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }

  // Probes report even when they did not decide the verdict — otherwise "why
  // does it keep going?" is answerable for the check and not for them.
  const probes = result.probes || {};
  for (const passed of probes.passed || []) out(`probe ${passed.probeId}: PASS${passed.summary ? ` — ${passed.summary}` : ''}`);
  for (const pending of probes.pending || []) out(`probe ${pending.probeId}: still running`);
  for (const abstained of probes.abstained || []) {
    out(`probe ${abstained.probeId}: abstained${abstained.summary ? ` — ${abstained.summary}` : ''}`);
    if (abstained.summons) out(`  the ${abstained.summons} skill is what produces the evidence it wants`);
  }

  if (!result.verification) {
    const armed = (probes.passed || []).length + (probes.pending || []).length + (probes.abstained || []).length;
    if (armed) {
      out('');
      out('Probes veto but never prove, so none of the above can close this goal on its own.');
    }
    out('Nothing here can prove this objective done.');
    out('Add one with:  bandaid goal set "<objective>" --check "npm test"');
    out(`Or turn the judge on in ${config.configPath()}:  {"goals":{"judge":true}}`);
    process.exitCode = 1;
    return;
  }

  out(`${result.verification.source}: ${result.proven ? 'PASS' : 'FAIL'}`);
  if (result.reason) out(result.reason);
  if (result.verification.output) {
    out('');
    out(result.verification.output);
  }
  if (!result.proven) process.exitCode = 1;
}

/**
 * What this project's tools actually cost. The only surface the duration profile
 * has — it is read by the estimator, not shown to the model.
 */
function cmdDurations(flags) {
  const cwd = flags.cwd || process.cwd();
  const root = project.projectRoot(cwd);
  const durations = require('../src/lib/durations');

  // Fold in anything the transcript has that the profile has not seen. A CLI run
  // has no transcript path, so this only helps when one is passed explicitly.
  if (flags.transcript) durations.sync(root, flags.transcript);

  const result = durations.profile(root);
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (!result) {
    out('No tool durations recorded for this project yet.');
    out('They accumulate from the transcript at every stop.');
    return;
  }

  out(`tool durations for ${root}`);
  out(`  synced through ${result.syncedThrough || 'never'}`);
  out('');
  // Milliseconds, not formatDuration: this is a measurement table, and a tool
  // that takes 233ms must not render as "just now".
  const ms = (n) => (n == null ? '—' : `${n}ms`);

  const rows = Object.entries(result.tools).sort((a, b) => b[1].n - a[1].n);
  for (const [name, s] of rows) {
    const derivations = Object.entries(s.timing)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    out(
      `  ${name.padEnd(18)} n=${String(s.n).padStart(4)}  p50 ${ms(s.p50).padStart(9)}  p95 ${ms(s.p95).padStart(10)}  max ${ms(
        s.max,
      ).padStart(10)}  ${derivations}`,
    );
  }
}

/**
 * What the model said it would do, and how long each of those took. An
 * observation of the model's own plan, never a bar it is graded against.
 */
/**
 * The estimate for one goal, gathering the two things it can be built from.
 *
 * Shared by `goal show` and the Stop hook's capacity line so both report the same
 * number — the same reason `check` is resolved in one place.
 */
function goalEstimate(sessionId, goal) {
  if (!goal) return null;
  try {
    const eta = require('../src/lib/eta');
    const taskState = require('../src/lib/tasks').state(sessionId);

    let coverage = null;
    if (goal.projectRoot && (goal.criteria || []).length) {
      const evidence = require('../src/lib/evidence');
      const { worktreeStamp } = require('../src/lib/stamp');
      coverage = evidence.coverage(
        evidence.read(goal.projectRoot, { objectiveHash: evidence.objectiveHash(goal.objective) }),
        goal.criteria.length,
        worktreeStamp(goal.projectRoot),
      );
    }
    return eta.estimate(goal, { taskState, coverage });
  } catch {
    return null;
  }
}

function cmdTasks(flags) {
  const sessionId = resolveSession(flags);
  if (!sessionId) {
    fail('no session found. Pass --session <id>.');
    return;
  }

  const result = require('../src/lib/tasks').state(sessionId);
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (!result) {
    out('No task list recorded for this session.');
    return;
  }

  out(`tasks for ${sessionId}`);
  out(
    `  ${result.completed}/${result.total} complete` +
      `${result.inProgress ? `, ${result.inProgress} in progress` : ''}` +
      `${result.pending ? `, ${result.pending} pending` : ''}` +
      `${result.dropped ? `, ${result.dropped} dropped` : ''}`,
  );
  if (result.durations.length) {
    const sorted = [...result.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    out(`  ${result.durations.length} measured, median ${formatDuration(median)}`);
    if (result.fuzzyDurations) out(`  ${result.fuzzyDurations} of those came from a guessed match`);
  } else {
    out('  no durations yet — a task needs to go in_progress and then completed');
  }
  out('');
  for (const task of result.tasks) {
    const took = task.activeMs == null ? '' : `  (${formatDuration(task.activeMs)})`;
    out(`  [${task.status.padEnd(11)}] ${String(task.title || task.taskId).slice(0, 68)}${took}`);
  }
}

function cmdInspect(flags) {
  const sessionId = resolveSession(flags);
  if (!sessionId) {
    fail('no session found. Pass --session <id>.');
    return;
  }

  const prompts = store.readPrompts(sessionId);
  const turns = store.readTurns(sessionId);
  const { approxTokenCount } = require('../src/lib/tokens');
  const promptTokens = prompts.reduce((n, p) => n + approxTokenCount(p.text), 0);

  if (flags.json) {
    out(JSON.stringify({ sessionId, prompts, turns }, null, 2));
    return;
  }

  out(`session ${sessionId}`);
  out(`  ${prompts.length} user prompt(s), ~${promptTokens} tokens verbatim`);
  out(`  ${turns.length} tool batch(es), ${turns.reduce((n, t) => n + (t.calls?.length || 0), 0)} call(s)`);
  out('');
  prompts.forEach((p, i) => {
    const preview = p.text.replace(/\s+/g, ' ').slice(0, 90);
    out(`  ${String(i + 1).padStart(3)}. ${preview}${p.text.length > 90 ? '…' : ''}`);
  });
}

function cmdPreview(flags) {
  const sessionId = resolveSession(flags);
  if (!sessionId) {
    fail('no session found. Pass --session <id>.');
    return;
  }
  const cfg = config.loadConfig();
  const restored = buildRestoreBlock({
    prompts: store.readPrompts(sessionId),
    batches: store.readTurns(sessionId),
    config: cfg,
    goal: goals.loadGoal(sessionId),
  });
  if (!restored) {
    out('Nothing to restore for this session yet.');
    return;
  }
  if (flags.stats) {
    out(JSON.stringify(restored.stats, null, 2));
    return;
  }
  out(restored.text);
}

function cmdPrompt() {
  out(SUMMARIZATION_PROMPT);
  out('');
  out(COMPACTION_FIDELITY_ADDENDUM);
}

/**
 * The evidence ledger.
 *
 * `add` is the model's only way in, and it is deliberately narrow: whatever it
 * asks for, the record lands as an unverified claim. A claim with a pointer is
 * a lead for a reviewer to check; it is never a finding, and nothing the model
 * writes can be mistaken for something the runtime measured.
 */
function cmdEvidence(positional, flags) {
  const [sub, ...rest] = positional;
  const sessionId = resolveSession(flags);
  const goal = sessionId ? goals.loadGoal(sessionId) : null;

  if (!goal || !goal.projectRoot) {
    fail('no active goal with a project to record evidence against');
    return;
  }

  const evidence = require('../src/lib/evidence');
  const { worktreeStamp } = require('../src/lib/stamp');
  const hash = evidence.objectiveHash(goal.objective);

  if ((sub || 'show') === 'show') {
    const entries = evidence.read(goal.projectRoot, { objectiveHash: hash });
    if (flags.json) {
      out(JSON.stringify(entries, null, 2));
      return;
    }
    if (!entries.length) {
      out('No evidence recorded for this objective yet.');
      return;
    }
    const stamp = worktreeStamp(goal.projectRoot);
    out(evidence.render(entries, { currentStamp: stamp, maxTokens: 100000 }));
    return;
  }

  if (sub !== 'add') {
    fail(`unknown evidence subcommand "${sub}"`);
    return;
  }

  const claim = rest.join(' ').trim();
  if (!claim) {
    fail('evidence add needs a claim: what is now true');
    return;
  }

  const pointers = [].concat(flags.pointer || []).filter((p) => typeof p === 'string');
  const criterion = flags.criterion ? Number.parseInt(flags.criterion, 10) : null;

  const record = evidence.append(
    goal.projectRoot,
    {
      sessionId,
      objectiveHash: hash,
      criterion,
      claim,
      pointers,
      stamp: worktreeStamp(goal.projectRoot).fp,
    },
    { byModel: true },
  );

  if (!record) {
    fail('nothing recorded');
    return;
  }
  out(`Recorded as an unverified claim${criterion ? ` against criterion ${criterion}` : ''}.`);
  if (!pointers.length) {
    out('No pointer was given, so a reviewer has nowhere to go and check it. Pass --pointer file.js:12 or --pointer "cmd:npm test".');
  }
}

/**
 * Probes: the manifest, its trust state, and what each one last said.
 *
 * `trust` is the gate everything else waits behind. A committed manifest is
 * arbitrary shell execution the moment somebody opens the repository, so
 * nothing in it runs until its exact contents have been approved.
 */
function cmdProbes(positional, flags) {
  const [sub = 'list'] = positional;
  const cwd = flags.cwd || process.cwd();
  const cfg = config.loadConfig();
  const probes = require('../src/lib/probes');
  const trust = require('../src/lib/trust');

  const manifest = probes.loadManifest(cwd, cfg);
  const file = probes.manifestPath(cwd, cfg);
  const state = trust.status(cwd, file);

  if (sub === 'trust') {
    if (state.state === 'missing') {
      fail(`no manifest at ${file}`);
      return;
    }
    if (state.state === 'unsafe') {
      fail(state.reason);
      out('A manifest anyone else on this machine can rewrite is not made safe by being approved once.');
      return;
    }
    if (state.state === 'trusted') {
      out('Already trusted, and unchanged since.');
      return;
    }

    out(`${state.state === 'changed' ? 'This manifest has changed since it was approved' : 'This manifest has never been approved'}:`);
    out('');
    out(fs.readFileSync(file, 'utf8').trimEnd());
    out('');
    out('Every command above will be run by Bandaid, in this project, with your permissions.');
    if (!flags.yes) {
      out('');
      out('Re-run with --yes to approve it.');
      process.exitCode = 1;
      return;
    }
    trust.trust(cwd, file);
    out(`Approved. ${manifest ? manifest.probes.length : 0} probe(s) may now run.`);
    return;
  }

  if (sub === 'untrust') {
    trust.untrust(cwd);
    out('Approval withdrawn. Every probe in this project will abstain until it is approved again.');
    return;
  }

  if (sub !== 'list') {
    fail(`unknown probes subcommand "${sub}"`);
    return;
  }

  out(`manifest: ${file}`);
  out(`trust:    ${state.state}${state.reason ? ` (${state.reason})` : ''}`);
  if (!manifest || !manifest.probes.length) {
    out('');
    out('No probes declared. See the bandaid-* skills for what a probe looks like.');
    return;
  }
  if (state.state !== 'trusted') {
    out('');
    out('Every probe below is abstaining until the manifest is approved:  bandaid probes trust');
  }
  out('');
  for (const probe of manifest.probes) {
    out(`  ${probe.id}`);
    if (probe.description) out(`      ${probe.description}`);
    out(`      run:  ${probe.run}`);
    if (probe.when && probe.when.changed) out(`      when: ${probe.when.changed.join(', ')} changed`);
    if (probe.summons) out(`      skill:${probe.summons}`);
  }
}

function cmdProbe(positional, flags) {
  const [sub = 'status', name] = positional;
  const sessionId = resolveSession(flags);
  const goal = sessionId ? goals.loadGoal(sessionId) : null;
  const cwd = flags.cwd || (goal && goal.projectRoot) || process.cwd();
  const cfg = config.loadConfig();
  const probes = require('../src/lib/probes');

  if (sub === 'status') {
    const rows = probes.probeStatus({ goal, config: cfg, cwd });
    if (flags.json) {
      out(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      out('No probes declared for this project.');
      return;
    }
    for (const row of rows) {
      const marks = [row.armed ? 'armed' : 'not armed', row.applicable ? 'applies' : 'not applicable to this goal'];
      if (row.running) marks.push('running');
      out(`  ${row.id.padEnd(12)} ${row.verdict.padEnd(8)} ${marks.join(', ')}`);
      if (row.summary) out(`               ${row.summary}`);
    }
    return;
  }

  if (sub === 'clear') {
    probes.clearCache(cwd, name || null);
    out(name ? `Cleared the cached verdict for ${name}.` : 'Cleared every cached probe verdict.');
    return;
  }

  if (sub === 'arm' || sub === 'disarm') {
    if (!goal) {
      fail('no active goal to arm a probe against');
      return;
    }
    if (!name) {
      fail(`probe ${sub} needs a probe id`);
      return;
    }
    const manifest = probes.loadManifest(cwd, cfg);
    const known = manifest ? manifest.probes.map((p) => p.id) : [];
    if (sub === 'arm' && !known.includes(name)) {
      fail(`no probe "${name}" in the manifest (${known.join(', ') || 'none declared'})`);
      return;
    }
    const current = Array.isArray(goal.probes) ? goal.probes : known;
    const next = sub === 'arm' ? [...new Set([...current, name])] : current.filter((id) => id !== name);
    goals.saveGoal(sessionId, { ...goal, probes: next });
    out(`${sub === 'arm' ? 'Armed' : 'Disarmed'} ${name}. Now armed: ${next.join(', ') || 'none'}.`);
    return;
  }

  if (sub === 'run') {
    if (!name) {
      fail('probe run needs a probe id');
      return;
    }
    const manifest = probes.loadManifest(cwd, cfg);
    const probe = manifest && manifest.probes.find((p) => p.id === name);
    if (!probe) {
      fail(`no probe "${name}" in the manifest`);
      return;
    }
    const trust = require('../src/lib/trust');
    if (!trust.isTrusted(cwd, manifest.file)) {
      fail('the manifest is not approved; run `bandaid probes trust` first');
      return;
    }

    const { worktreeStamp } = require('../src/lib/stamp');
    const stamp = worktreeStamp(cwd);
    const result = probes.runProbe(probe, { cwd, goal, config: cfg, stampFp: stamp.fp });
    probes.writeCache(cwd, name, result);

    out(`${name}: ${result.verdict}${result.exitCode == null ? '' : ` (exit ${result.exitCode})`}`);
    if (result.summary) out(`  ${result.summary}`);
    for (const finding of result.findings || []) {
      out(`  - ${finding.message || JSON.stringify(finding)}`);
    }
    if (result.verdict === 'fail') process.exitCode = 1;
    return;
  }

  fail(`unknown probe subcommand "${sub}"`);
}

/**
 * The completion audit, computed instead of asked for.
 *
 * `src/lib/prompts.js` spends 277 words asking the model to grade each
 * criterion honestly and to treat absence of contradiction as absence of
 * proof. This is that, as arithmetic over a file the model can only append
 * unverified claims to — so it is not up for negotiation, and it names the one
 * thing to do about each gap.
 */
function cmdSelfCheck(flags) {
  const sessionId = resolveSession(flags);
  const goal = sessionId ? goals.loadGoal(sessionId) : null;
  if (!goal) {
    fail('no active goal to check');
    return;
  }

  const criteria = goal.criteria || [];
  if (!criteria.length) {
    out('This goal has no acceptance criteria, so there is nothing to grade against.');
    out('Record 2–5 with `bandaid goal criteria`, and they become the fixed bar.');
    return;
  }
  if (!goal.projectRoot) {
    fail('this goal has no project, so no evidence has been recorded against it');
    return;
  }

  const evidence = require('../src/lib/evidence');
  const selfcheck = require('../src/lib/selfcheck');
  const { worktreeStamp } = require('../src/lib/stamp');

  const stamp = worktreeStamp(goal.projectRoot);
  const entries = evidence.read(goal.projectRoot, { objectiveHash: evidence.objectiveHash(goal.objective) });
  const rows = evidence.coverage(entries, criteria.length, stamp);
  const covered = rows.filter((r) => r.state === 'covered').length;

  if (flags.json) {
    out(JSON.stringify({ covered, total: criteria.length, rows }, null, 2));
    return;
  }

  out(`coverage: ${covered} of ${criteria.length} criteria have measured, current evidence.`);
  if (stamp.method !== 'git') {
    out('(no version control here, so every record counts as historical)');
  }
  out('');

  const ADVICE = {
    covered: null,
    refuted: 'a verifier says this is not true right now — that is the thing to fix',
    contradicted:
      'two verifiers looking at the same worktree disagree. Another attempt is worthless until you find out which is right — read both records and their pointers.',
    'claimed-only': 'you asserted this; nothing measured it. Add a check, a probe, or an expectation that fails if it stops being true.',
    stale: 'this was measured before the worktree changed. Run it again.',
    uncovered: 'nothing has been recorded for this criterion at all.',
  };

  for (const row of rows) {
    out(`  ${row.criterion}. ${criteria[row.criterion - 1]}`);
    const detail = row.record ? ` — ${row.record.claim}` : '';
    out(`     ${row.state}${detail}`);
    if (ADVICE[row.state]) out(`     ${ADVICE[row.state]}`);
  }

  const expectations = selfcheck.runExpectations(goal, { cwd: goal.projectRoot });
  if (expectations.verdict !== 'abstain') {
    out('');
    out(`expectations: ${expectations.checked - expectations.failures.length} of ${expectations.checked} hold.`);
    if (expectations.failures.length) out(selfcheck.renderFailures(expectations.failures));
  }

  const scope = selfcheck.checkScope(goal, { cwd: goal.projectRoot });
  if (scope.verdict === 'fail') {
    out('');
    out(`scope: ${scope.violations.length} file(s) changed outside the declared paths.`);
    for (const file of scope.violations.slice(0, 20)) out(`  ${file}`);
  }

  if (covered !== criteria.length) process.exitCode = 1;
}

function cmdSessions(positional, flags) {
  if ((positional[0] || '') === 'prune') {
    const retention = config.loadConfig().retention || {};
    const result = store.pruneSessions({
      maxAgeDays: flags['older-than'] ? Number(flags['older-than']) : (retention.sessionMaxAgeDays ?? 30),
      maxCount: flags.keep ? Number(flags.keep) : (retention.sessionMaxCount ?? 200),
      dryRun: flags['dry-run'] === true || flags['dry-run'] === 'true',
    });
    if (!result.removed.length) {
      out(`Nothing to prune. ${result.kept} session(s) kept.`);
      return;
    }
    out(`${result.dryRun ? 'Would remove' : 'Removed'} ${result.removed.length} session(s); ${result.kept} kept.`);
    for (const id of result.removed) out(`  ${id}`);
    out('');
    out('Sessions with an active goal are never pruned.');
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(store.sessionsDir(), { withFileTypes: true });
  } catch {
    out('No sessions recorded yet.');
    return;
  }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const prompts = store.readPrompts(id);
    if (!prompts.length) continue;
    rows.push({ id, count: prompts.length, last: prompts[prompts.length - 1].ts || '' });
  }
  rows.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  if (!rows.length) {
    out('No sessions recorded yet.');
    return;
  }
  for (const row of rows) out(`  ${row.id}  ${String(row.count).padStart(4)} prompt(s)  ${row.last}`);
}

// --- entry ---------------------------------------------------------------

function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const command = positional.shift();

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return;
    case 'version':
    case '--version':
    case '-v':
      out(pkg.version);
      return;
    case 'status':
      return cmdStatus(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'install':
      return cmdInstall(flags);
    case 'uninstall':
      return cmdUninstall(flags);
    case 'on':
      return cmdToggle(true);
    case 'off':
      return cmdToggle(false);
    case 'goal':
      return cmdGoal(positional, flags);
    case 'verify':
      return cmdVerify(flags);
    case 'inspect':
      return cmdInspect(flags);
    case 'durations':
      return cmdDurations(flags);
    case 'tasks':
      return cmdTasks(flags);
    case 'preview':
      return cmdPreview(flags);
    case 'prompt':
      return cmdPrompt();
    case 'evidence':
      return cmdEvidence(positional, flags);
    case 'probes':
      return cmdProbes(positional, flags);
    case 'probe':
      return cmdProbe(positional, flags);
    case 'self-check':
      return cmdSelfCheck(flags);
    case 'sessions':
      return cmdSessions(positional, flags);
    default:
      fail(`unknown command "${command}". Run "bandaid help".`);
  }
}

main(process.argv.slice(2));
