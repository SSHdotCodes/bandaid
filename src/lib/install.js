'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Standalone installer.
 *
 * The plugin path (`/plugin install bandaid@bandaid`) is the recommended one
 * and needs none of this. `bandaid install` exists for people who would rather
 * wire the hooks into settings.json directly, or who need Bandaid in a project
 * that does not use plugins.
 *
 * Every hook entry is tagged so uninstall can find and remove exactly what we
 * added without disturbing the user's own hooks.
 */

const MARKER = 'bandaid';

/**
 * Must stay byte-for-byte in step with `hooks/hooks.json`, which is what the
 * plugin install path uses. They disagreed once — 20s here against 30s there —
 * and the two install paths silently produced different behaviour under a slow
 * restore. `test/hooks.e2e.test.js` asserts they agree on every event *and*
 * timeout — the comment previously named `test/install.test.js`, which does not
 * exist and never has.
 *
 * The Stop budget has to clear the slowest verifier it can run. The judge is
 * measured at 12–16s and `goals.verifyTimeoutMs` defaults to 120s, so a 15s
 * hook was killing verdicts mid-flight — and a killed hook is not exit 2, so
 * the stop went through unverified. That is a fail-open in the one place this
 * whole design is a fail-closed loop.
 */
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit', file: 'user-prompt-submit.js', timeout: 10 },
  { event: 'PostToolBatch', file: 'post-tool-batch.js', timeout: 10 },
  { event: 'PreCompact', file: 'pre-compact.js', timeout: 30 },
  { event: 'SessionStart', file: 'session-start.js', timeout: 30 },
  { event: 'PostCompact', file: 'post-compact.js', timeout: 10 },
  { event: 'Stop', file: 'stop.js', timeout: 130 },
];

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function settingsPath(scope) {
  if (scope === 'project') return path.join(process.cwd(), '.claude', 'settings.json');
  if (scope === 'local') return path.join(process.cwd(), '.claude', 'settings.local.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bandaid-backup`);
  }
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function hookCommand(file) {
  return `node ${JSON.stringify(path.join(repoRoot(), 'src', 'hooks', file))}`;
}

function buildEntry({ event, file, timeout }) {
  return {
    hooks: [
      {
        type: 'command',
        command: hookCommand(file),
        timeout,
        statusMessage: event === 'SessionStart' ? 'Restoring context (bandaid)' : undefined,
        [MARKER]: true,
      },
    ],
  };
}

function isOurs(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => h && (h[MARKER] === true || String(h.command || '').includes(`${path.sep}bandaid${path.sep}src${path.sep}hooks${path.sep}`)));
}

function install({ scope = 'user' } = {}) {
  const file = settingsPath(scope);
  const settings = readSettings(file);
  settings.hooks = settings.hooks || {};

  const added = [];
  for (const spec of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[spec.event]) ? settings.hooks[spec.event] : [];
    const cleaned = list.filter((entry) => !isOurs(entry));
    const entry = buildEntry(spec);
    // Strip undefined so the written JSON stays clean.
    entry.hooks = entry.hooks.map((h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)));
    cleaned.push(entry);
    settings.hooks[spec.event] = cleaned;
    added.push(spec.event);
  }

  writeSettings(file, settings);
  return { file, added };
}

function uninstall({ scope = 'user' } = {}) {
  const file = settingsPath(scope);
  if (!fs.existsSync(file)) return { file, removed: [] };

  const settings = readSettings(file);
  const removed = [];
  for (const spec of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks?.[spec.event]) ? settings.hooks[spec.event] : null;
    if (!list) continue;
    const cleaned = list.filter((entry) => !isOurs(entry));
    if (cleaned.length !== list.length) removed.push(spec.event);
    if (cleaned.length) settings.hooks[spec.event] = cleaned;
    else delete settings.hooks[spec.event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(file, settings);
  return { file, removed };
}

function installedEvents({ scope = 'user' } = {}) {
  const settings = readSettings(settingsPath(scope));
  return HOOK_EVENTS.filter((spec) => (settings.hooks?.[spec.event] || []).some(isOurs)).map((s) => s.event);
}

module.exports = { HOOK_EVENTS, install, installedEvents, repoRoot, settingsPath, uninstall };
