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

const pkg = require('../package.json');

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
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[(i += 1)];
      else flags[key] = true;
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
      --budget <tokens>      Stop continuing after roughly this many tokens
  goal criteria [<c> ...]    Record the fixed acceptance criteria, or list them
      --replace              Overwrite criteria that were already fixed
  goal block <reason>        Record something this environment cannot do, and keep going
  goal complete [note]       Mark the objective achieved (this is what the model calls)
  goal blocked [note]        Mark the whole objective blocked and stop
  goal adopt | goal resume   Take up the objective this project left open
  goal history               Show the project's open objective and its sessions
  goal clear [--project]     Drop the session's objective, or the project's record
  verify                     Run the check command and the judge now, and report

  inspect [--session ID]     Summarize the ledger for a session
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
const GOAL_WRITES = new Set(['set', 'criteria', 'complete', 'done', 'block', 'blocked', 'clear', 'adopt', 'resume']);

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
      const effectiveCheck = goal.check ?? config.loadConfig().goals.check;
      out(`check:         ${effectiveCheck || 'none'}`);
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
      const cwd = flags.cwd || process.cwd();
      goals.setGoal(sessionId, objective, {
        source: 'explicit',
        // Resolved with the check in hand, so `--check` earns the longer leash
        // in the same breath that it supplies the thing doing the verifying.
        maxContinuations: flags['max-continuations']
          ? Number(flags['max-continuations'])
          : goals.resolveMaxContinuations(cfg, { check }),
        tokenBudget: flags.budget ? Number(flags.budget) : null,
        // Scope the goal to the work that follows it. Without this an explicit
        // goal gets turnIndex 0 and `turnsForGoal` sweeps the whole session, so
        // both the token estimate and the judge's evidence include work that
        // predates the objective.
        turnIndex: ledger.currentTurnIndex(sessionId),
        check,
        cwd,
      });
      out(`Goal set for session ${sessionId}.`);
      if (typeof flags.check === 'string') {
        out(`It closes automatically when \`${flags.check}\` exits 0.`);
      }
      return;
    }
    case 'criteria': {
      const goal = goals.loadGoal(sessionId);
      if (!goal) {
        fail('no active goal to attach criteria to');
        return;
      }
      if (!rest.length) {
        const existing = goal.criteria || [];
        if (!existing.length) out('No criteria recorded.');
        for (const [i, text] of existing.entries()) out(`${i + 1}. ${text}`);
        return;
      }
      const before = (goal.criteria || []).length;
      const updated = goals.setCriteria(sessionId, rest, {
        source: 'model',
        replace: flags.replace === true || flags.replace === 'true',
      });
      if (before && !flags.replace) {
        out(`Criteria already fixed for this goal (${before}); pass --replace to overwrite them.`);
        return;
      }
      out(`Recorded ${updated.criteria.length} acceptance criteria. They are now the bar every turn.`);
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
  });

  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.verification) {
    out('No verification configured for this goal.');
    out('Add one with:  bandaid goal set "<objective>" --check "npm test"');
    out(`Or turn the judge on in ${config.configPath()}:  {"goals":{"judge":true}}`);
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
    case 'preview':
      return cmdPreview(flags);
    case 'prompt':
      return cmdPrompt();
    case 'sessions':
      return cmdSessions(positional, flags);
    default:
      fail(`unknown command "${command}". Run "bandaid help".`);
  }
}

main(process.argv.slice(2));
