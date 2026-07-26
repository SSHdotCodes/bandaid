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

    // Skip the completion audit for turns that changed nothing.
    skipTrivialTurns: true,

    // Consecutive turns reporting the same blocker before "blocked" is allowed.
    blockedThreshold: 3,

    // Shell command that proves the objective is done. Exit 0 closes the goal;
    // any other status vetoes the stop no matter how finished the model feels.
    // Set per goal with `bandaid goal set ... --check`, or globally here.
    check: null,

    // Ask a separate read-only Claude to verify against the worktree before a
    // goal is allowed to close. Costs a subprocess and a few seconds per stop.
    judge: false,
    judgeModel: 'haiku',

    // Ceiling for one check command or one judge run.
    verifyTimeoutMs: 120000,

    // Identical verification failures in a row before Bandaid stops asking.
    // Guards the case neither Codex nor Claude Code detects: real-looking work
    // every turn that never moves the failure.
    plateauLimit: 2,
  },

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
  const maxCont = int('BANDAID_MAX_CONTINUATIONS');
  if (maxCont !== undefined) goals.maxContinuations = maxCont;
  if (process.env.BANDAID_GOAL_CHECK) goals.check = process.env.BANDAID_GOAL_CHECK;
  const judge = bool('BANDAID_JUDGE');
  if (judge !== undefined) goals.judge = judge;
  if (process.env.BANDAID_JUDGE_MODEL) goals.judgeModel = process.env.BANDAID_JUDGE_MODEL;
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
