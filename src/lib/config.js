'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  enabled: true,

  compact: {
    enabled: true,

    // Codex's COMPACT_USER_MESSAGE_MAX_TOKENS. The budget for user prompts
    // replayed verbatim after a compaction, spent newest-first.
    userMessageMaxTokens: 20000,

    // Ceiling for a single turn digest before it is middle-truncated.
    turnDigestMaxTokens: 20000,

    // Total budget for turn digests replayed after a compaction.
    digestBudgetTokens: 20000,

    // Ceiling for one tool result inside a turn digest.
    toolResultMaxTokens: 900,

    // Ceiling for one tool's input params inside a turn digest.
    toolInputMaxTokens: 400,

    // Replace Claude Code's summarization directive with Codex's
    // CONTEXT CHECKPOINT COMPACTION handoff prompt.
    useCodexSummaryPrompt: true,

    // Record turn digests as tools run. Disable to keep only verbatim prompts.
    recordTurns: true,
  },

  goals: {
    enabled: true,

    // auto     — every substantive user prompt becomes the active objective
    // explicit — only /bandaid:goal sets an objective
    // off      — never block a stop
    mode: 'auto',

    // How many times a single objective may block a stop. Codex bounds
    // continuations by token budget; Bandaid bounds by count so a wedged
    // goal can never loop forever.
    //
    // The cap tracks how strong the verifier is, because a goal closed by an
    // exit status is bounded by that status and not by this number, while a
    // goal nothing can check is bounded by nothing else at all. Set a plain
    // number here to override all three tiers.
    maxContinuations: { verified: 8, judged: 4, unverified: 2 },

    // Optional token budget per goal. null = unbounded.
    tokenBudget: null,

    // Optional wall-clock budget per goal, in milliseconds. null = unbounded.
    //
    // best-goal-report.md specifies budgets enforced on turns, tokens *and*
    // wall-clock, and convicts Codex of tracking elapsed time while never
    // enforcing it. Turns and tokens shipped; this is the third.
    //
    // Note what this is not: stamp.js rejects time-based logic for deciding
    // whether recorded evidence still describes the worktree, and is right to —
    // that stays content-hashed. This answers a different question, the one
    // tokenBudget already answers with a number: how much of a finite resource
    // is left.
    timeBudgetMs: null,

    // Skip the completion audit for turns that changed nothing.
    skipTrivialTurns: true,

    // Whether a trailing question mark still ends the turn unconditionally.
    //
    // Off by default, because it changes when Bandaid refuses to let a turn end
    // and every existing user would get that on upgrade. With it on, a request for
    // permission to do work already in scope — "Should I proceed?" — no longer
    // releases the loop, while a genuine question the environment cannot answer
    // still does. Anything the classifier is unsure about still does too: see
    // src/lib/autonomy.js for why uncertainty resolves to the old behaviour.
    autonomy: false,

    // What a brand-new session does about an objective left open in this
    // project. "offer" names it and arms nothing, so picking it up is a
    // decision; "auto" adopts it, which is the unattended multi-day mode and
    // will occasionally pick up an unrelated task from the same repository;
    // "off" is the behaviour before project records existed.
    carryOver: 'offer',

    // Shell command that proves the objective is done. Exit 0 closes the goal;
    // any other status vetoes the stop no matter how finished the model feels.
    // Set per goal with `bandaid goal set ... --check`, or globally here.
    check: null,

    // Ask a separate read-only Claude to verify against the worktree before a
    // goal is allowed to close. Costs a subprocess and a few seconds per stop.
    judge: false,
    judgeModel: 'haiku',
    // The binary to run the judge with. Overridable so a session whose Claude
    // Code lives under another name can still verify — and so the end-to-end
    // tests can drive a verdict without a network round trip.
    judgeCli: 'claude',

    // Ceiling for one check command or one judge run.
    verifyTimeoutMs: 120000,

    // Identical verification failures in a row before Bandaid stops asking.
    // Guards the case neither Codex nor Claude Code detects: real-looking work
    // every turn that never moves the failure.
    plateauLimit: 2,

    // Blockers the model may record before Bandaid stops continuing the goal.
    // Separate from plateauLimit because it catches the opposite failure: not
    // work that keeps failing the same way, but work this environment cannot do
    // at all, which no number of further turns changes.
    blockerLimit: 2,
  },

  // Verification that takes longer than a hook and may decline to answer.
  // Commands live in the project's committed .bandaid/probes.json, never here:
  // a command in a per-machine config does not travel with the project, which
  // is the whole reason the manifest exists.
  probes: {
    enabled: true,
    manifest: '.bandaid/probes.json',
    // Holds on closing a goal while a probe is still in flight, so a verdict
    // that arrives a second late is not simply missed.
    maxDefers: 3,
    defaultTimeoutMs: 600000,
    artifactRoot: '.bandaid/artifacts',
    // Never set this false. It exists so that turning it off is a line in a
    // diff somebody reviews.
    requireTrust: true,
  },

  // Nothing here has ever been deleted: one directory per session, forever,
  // and a turns.jsonl that reaches megabytes in a day. A session with an active
  // goal is exempt from all of it — that is the long-horizon case, and losing
  // it is the failure the goal system exists to prevent.
  retention: {
    enabled: true,
    // Sessions untouched for this long are dropped.
    sessionMaxAgeDays: 30,
    // Hard ceiling regardless of age, newest kept.
    sessionMaxCount: 200,
    // How often the automatic sweep is allowed to run, in hours.
    sweepIntervalHours: 24,
  },

  // Prompt blocks to withhold, by name. Empty in every real run.
  //
  // This exists so eval/loop.js can measure whether a block earns its tokens:
  // a mechanism that cannot be withheld cannot be ablated, and one that cannot be
  // ablated ships on an assumption. Set through BANDAID_ABLATE rather than a config
  // file, because it is a measurement knob and not a preference.
  ablate: [],

  debug: false,
};

function homeDir() {
  return process.env.BANDAID_HOME || path.join(os.homedir(), '.claude', 'bandaid');
}

function configPath() {
  return process.env.BANDAID_CONFIG || path.join(homeDir(), 'config.json');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Env overrides are the escape hatch for one-off runs and CI. */
function envOverrides() {
  const out = {};
  const bool = (name) => {
    const raw = process.env[name];
    if (raw == null || raw === '') return undefined;
    return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
  };
  const int = (name) => {
    const raw = process.env[name];
    if (raw == null || raw === '') return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  const enabled = bool('BANDAID_ENABLED');
  if (enabled !== undefined) out.enabled = enabled;

  if (process.env.BANDAID_ABLATE) {
    out.ablate = process.env.BANDAID_ABLATE.split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  }

  const debug = bool('BANDAID_DEBUG');
  if (debug !== undefined) out.debug = debug;

  const compact = {};
  const compactEnabled = bool('BANDAID_COMPACT');
  if (compactEnabled !== undefined) compact.enabled = compactEnabled;
  const userMax = int('BANDAID_USER_MESSAGE_MAX_TOKENS');
  if (userMax !== undefined) compact.userMessageMaxTokens = userMax;
  const digestMax = int('BANDAID_DIGEST_BUDGET_TOKENS');
  if (digestMax !== undefined) compact.digestBudgetTokens = digestMax;
  if (Object.keys(compact).length) out.compact = compact;

  const goals = {};
  const goalsEnabled = bool('BANDAID_GOALS');
  if (goalsEnabled !== undefined) goals.enabled = goalsEnabled;
  if (process.env.BANDAID_GOAL_MODE) goals.mode = process.env.BANDAID_GOAL_MODE;
  if (process.env.BANDAID_CARRY_OVER) goals.carryOver = process.env.BANDAID_CARRY_OVER;
  const probesEnabled = bool('BANDAID_PROBES');
  if (probesEnabled !== undefined) out.probes = { enabled: probesEnabled };
  if (process.env.BANDAID_PROBE_MANIFEST) out.probes = { ...(out.probes || {}), manifest: process.env.BANDAID_PROBE_MANIFEST };
  const maxCont = int('BANDAID_MAX_CONTINUATIONS');
  if (maxCont !== undefined) goals.maxContinuations = maxCont;
  if (process.env.BANDAID_TIME_BUDGET) {
    // Accepts the same "90m"/"2h"/"5400000" forms as `goal set --time-budget`,
    // so a one-off run and a stored goal are configured the same way.
    const ms = require('./duration').parseDuration(process.env.BANDAID_TIME_BUDGET);
    if (ms != null) goals.timeBudgetMs = ms;
  }
  if (process.env.BANDAID_GOAL_CHECK) goals.check = process.env.BANDAID_GOAL_CHECK;
  const autonomy = bool('BANDAID_AUTONOMY');
  if (autonomy !== undefined) goals.autonomy = autonomy;
  const judge = bool('BANDAID_JUDGE');
  if (judge !== undefined) goals.judge = judge;
  if (process.env.BANDAID_JUDGE_MODEL) goals.judgeModel = process.env.BANDAID_JUDGE_MODEL;
  if (process.env.BANDAID_JUDGE_CLI) goals.judgeCli = process.env.BANDAID_JUDGE_CLI;
  if (Object.keys(goals).length) out.goals = goals;

  return out;
}

let cached = null;

function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const fileConfig = readJsonSafe(configPath()) || {};
  cached = deepMerge(deepMerge(DEFAULTS, fileConfig), envOverrides());
  return cached;
}

function saveConfig(partial) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readJsonSafe(file) || {};
  const next = deepMerge(current, partial);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  cached = null;
  return next;
}

module.exports = { DEFAULTS, configPath, deepMerge, homeDir, loadConfig, saveConfig };
