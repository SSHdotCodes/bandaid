#!/usr/bin/env node
'use strict';

/**
 * Built-in probe: a secret introduced by this work.
 *
 * Not a general secret scanner — those exist, they need installing, and they
 * report on the whole history. This one asks a much narrower question with a
 * much better answer rate: *did the agent just write a credential into the
 * repository?* That is the security failure agents actually cause, as opposed
 * to the one CVE databases describe.
 *
 * Two deliberate asymmetries:
 *
 *   - A hit in the diff **fails**. The work under this goal put it there.
 *   - A hit in a file this goal never touched is **reported and does not fail**.
 *     Blocking a goal on somebody else's old mistake is wrong, and it is how a
 *     gate gets switched off within a day.
 *
 * Exit 0 clean, 1 on a hit in the diff, 78 when there is no git to diff against.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ABSTAIN = 78;

/**
 * High precision over high recall, on purpose. A scanner that cries wolf gets
 * muted, and a muted gate is worse than no gate: every one of these has a
 * distinctive prefix or header rather than a shape that ordinary code hits.
 *
 * ponytail: no entropy heuristic. It is where the false positives live — base64
 * blobs, minified bundles, test fixtures — and the upgrade path is a real
 * scanner named in the manifest, which this probe deliberately does not
 * duplicate.
 */
const PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key header', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{40,}/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'connection string with an inline password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@/ },
];

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '');
}

/** `file:line:pattern` entries, one per line, `#` comments. */
function allowlist(root) {
  const file = path.join(root, '.bandaid', 'secrets-allow.txt');
  try {
    return new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.split('#')[0].trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Walk a unified diff, reporting only added lines with the file and line number
 * they land on. Removing a secret must not be reported as introducing one.
 */
function scanDiff(diff, allow) {
  const hits = [];
  let file = null;
  let lineNo = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).trim();
      file = name === '/dev/null' ? null : name.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)/.exec(line);
      lineNo = match ? Number(match[1]) - 1 : 0;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNo += 1;
      const text = line.slice(1);
      for (const { name, re } of PATTERNS) {
        if (!re.test(text)) continue;
        const key = `${file}:${lineNo}:${name}`;
        if (allow.has(key) || allow.has(`${file}:${name}`) || allow.has(file)) continue;
        hits.push({ file, line: lineNo, pattern: name });
      }
    } else if (!line.startsWith('-')) {
      lineNo += 1;
    }
  }

  return hits;
}

function main() {
  const root = process.cwd();
  const base = process.env.BANDAID_BASE_SHA || '';

  // Everything this goal changed: committed since it was set, plus whatever is
  // dirty or staged right now.
  const parts = [];
  if (base) {
    const committed = git(['diff', '--unified=0', `${base}..HEAD`], root);
    if (committed == null) {
      process.stderr.write('secrets: cannot diff against the goal\'s base commit; nothing to scan\n');
      process.exit(ABSTAIN);
    }
    parts.push(committed);
  }

  const working = git(['diff', '--unified=0', 'HEAD'], root);
  if (working == null && !base) {
    process.stderr.write('secrets: no git here, so there is no diff to scan\n');
    process.exit(ABSTAIN);
  }
  if (working) parts.push(working);

  // Untracked files are not in any diff, and a new file is exactly where a
  // credential lands.
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root) || '';
  const allow = allowlist(root);
  const hits = scanDiff(parts.join('\n'), allow);

  for (const rel of untracked.split('\n').map((l) => l.trim()).filter(Boolean)) {
    let text;
    try {
      const stat = fs.statSync(path.join(root, rel));
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      for (const { name, re } of PATTERNS) {
        if (!re.test(line)) continue;
        const key = `${rel}:${i + 1}:${name}`;
        if (allow.has(key) || allow.has(`${rel}:${name}`) || allow.has(rel)) continue;
        hits.push({ file: rel, line: i + 1, pattern: name });
      }
    });
  }

  const summary = hits.length
    ? `${hits.length} secret-shaped value(s) introduced by this work`
    : 'no credentials introduced by this work';

  process.stdout.write(
    `${JSON.stringify({
      summary,
      findings: hits.map((h) => ({
        criterion: null,
        severity: 'error',
        message: `${h.pattern} at ${h.file}:${h.line}`,
        pointer: `${h.file}:${h.line}`,
      })),
      metrics: { hits: hits.length },
    })}\n`,
  );

  if (hits.length) {
    process.stderr.write('Allow a deliberate one in .bandaid/secrets-allow.txt as "file:line:pattern".\n');
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`secrets: ${String((err && err.message) || err)}\n`);
  process.exit(1);
}
