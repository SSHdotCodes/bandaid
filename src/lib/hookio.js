'use strict';

const { loadConfig } = require('./config');

/**
 * Hook plumbing.
 *
 * Bandaid sits in the critical path of every prompt, every tool batch, and
 * every stop. The governing rule is that a bug in Bandaid must never break the
 * user's session: unexpected failures exit 0 silently (or with a debug note),
 * leaving Claude Code to behave exactly as it would without the plugin.
 */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function readHookInput() {
  const raw = await readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Text emitted here reaches the model (exit 0 paths). */
function emit(text) {
  if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Text emitted here reaches the model as blocking feedback (exit 2 paths). */
function emitBlocking(text) {
  if (text) process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Run a hook body. `fn` receives `{ input, config }` and may return an exit
 * code; anything thrown is swallowed so the session continues unimpeded.
 */
function runHook(name, fn) {
  readHookInput()
    .then(async (input) => {
      const config = loadConfig();
      if (!config.enabled) return 0;
      const code = await fn({ input, config });
      return typeof code === 'number' ? code : 0;
    })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Never surface a Bandaid crash as a broken hook.
      if (process.env.BANDAID_DEBUG) {
        process.stderr.write(`[bandaid] ${name} failed: ${err && err.stack ? err.stack : err}\n`);
      }
      process.exitCode = 0;
    });
}

module.exports = { emit, emitBlocking, readHookInput, runHook };
