#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');
const goals = require('../src/lib/goals');
const install = require('../src/lib/install');
const store = require('../src/lib/store');
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
  goal complete [note]       Mark the objective achieved (this is what the model calls)
  goal blocked [note]        Mark the objective blocked
  goal clear                 Drop the objective entirely

  inspect [--session ID]     Summarize the ledger for a session
  preview [--session ID]     Print exactly what would be injected after a compaction
  prompt                     Print the compaction prompt Bandaid installs
  sessions                   List sessions with a ledger

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
  out(`  goals:          ${cfg.goals.enabled ? cfg.goals.mode : 'off'} (max ${cfg.goals.maxContinuations} continuation(s) per goal)`);
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

function cmdGoal(positional, flags) {
  const [sub, ...rest] = positional;
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
      goals.setGoal(sessionId, objective, {
        source: 'explicit',
        maxContinuations: flags['max-continuations'] ? Number(flags['max-continuations']) : (cfg.goals.maxContinuations ?? 2),
        tokenBudget: flags.budget ? Number(flags.budget) : null,
      });
      out(`Goal set for session ${sessionId}.`);
      return;
    }
    case 'complete':
    case 'done': {
      const goal = goals.closeGoal(sessionId, 'complete', rest.join(' ') || null);
      out(goal ? 'Goal marked complete. Bandaid will stop asking about it.' : 'No active goal to complete.');
      return;
    }
    case 'blocked': {
      const goal = goals.closeGoal(sessionId, 'blocked', rest.join(' ') || null);
      out(goal ? 'Goal marked blocked.' : 'No active goal to block.');
      return;
    }
    case 'clear': {
      store.clearGoal(sessionId);
      out('Goal cleared.');
      return;
    }
    default:
      fail(`unknown goal subcommand "${sub}"`);
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

function cmdSessions() {
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
    case 'inspect':
      return cmdInspect(flags);
    case 'preview':
      return cmdPreview(flags);
    case 'prompt':
      return cmdPrompt();
    case 'sessions':
      return cmdSessions();
    default:
      fail(`unknown command "${command}". Run "bandaid help".`);
  }
}

main(process.argv.slice(2));
