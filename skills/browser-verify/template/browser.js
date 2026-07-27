#!/usr/bin/env node
'use strict';

/**
 * Template for `.bandaid/probes/browser.js`.
 *
 * Copy this into the project, then change the two marked places. It does not
 * open a browser: it grades the report the bandaid-browser-verify skill wrote,
 * which is what keeps Bandaid free of a browser dependency and keeps the
 * process that owns a dev server inside the session where you can see it.
 *
 * Exit 0 clean, 1 on a finding, 78 when there is no current report to grade.
 */

const fs = require('node:fs');
const path = require('node:path');

const ABSTAIN = 78;

// ---- change me (1 of 2): where the skill writes its report -----------------
const REPORT = process.env.BANDAID_ARTIFACT_DIR
  ? path.join(process.env.BANDAID_ARTIFACT_DIR, 'report.json')
  : path.join('.bandaid', 'artifacts', 'browser', 'report.json');

// ---- change me (2 of 2): the widths this project cares about ---------------
const REQUIRED = ['mobile', 'tablet', 'desktop'];

const MIN_SCREENSHOT_BYTES = 1024;

function abstain(message) {
  process.stderr.write(`browser: ${message}\n`);
  process.exit(ABSTAIN);
}

function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  } catch {
    abstain(`no report at ${REPORT}. Run the bandaid-browser-verify skill to produce one.`);
  }

  // A report taken against a different worktree is not evidence about this one.
  const stamp = process.env.BANDAID_STAMP || '';
  if (stamp && report.stamp && report.stamp !== stamp) {
    abstain('the report describes an earlier state of the worktree; re-run the skill.');
  }

  const findings = [];
  const seen = new Set((report.viewports || []).map((v) => v.name));

  for (const name of REQUIRED) {
    if (!seen.has(name)) findings.push({ severity: 'error', message: `no report for the ${name} viewport` });
  }

  for (const viewport of report.viewports || []) {
    const at = `${viewport.name} (${viewport.width}px)`;

    for (const error of viewport.consoleErrors || []) {
      findings.push({ severity: 'error', message: `console error at ${at}: ${String(error).slice(0, 200)}` });
    }

    for (const request of viewport.failedRequests || []) {
      const status = request.status || request;
      findings.push({ severity: 'error', message: `failed request at ${at}: ${status} ${request.url || ''}`.trim() });
    }

    const overflow = viewport.overflow || {};
    if (overflow.pageOverflow) {
      findings.push({ severity: 'error', message: `the page scrolls horizontally at ${at}` });
    }
    for (const element of overflow.overflow || []) {
      findings.push({
        severity: 'error',
        message: `${element.sel} overflows at ${at} (${element.scrollWidth} > ${element.clientWidth})`,
      });
    }

    for (const step of viewport.steps || []) {
      if (!step.ok) findings.push({ severity: 'error', message: `step "${step.step}" failed at ${at}` });
    }

    for (const assertion of viewport.assertions || []) {
      if (!assertion.ok) {
        findings.push({ severity: 'error', message: `assertion "${assertion.id}" failed at ${at}` });
      }
    }

    // The anti-fabrication gate: the cheapest way to pass this probe is to
    // write a clean report without opening a browser.
    if (viewport.screenshot) {
      const file = path.join(path.dirname(REPORT), viewport.screenshot);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      if (size < MIN_SCREENSHOT_BYTES) {
        findings.push({ severity: 'error', message: `no real screenshot for ${at} (${viewport.screenshot})` });
      }
    } else {
      findings.push({ severity: 'error', message: `no screenshot named for ${at}` });
    }
  }

  const viewports = (report.viewports || []).length;
  process.stdout.write(
    `${JSON.stringify({
      summary: findings.length
        ? `${viewports - new Set(findings.map((f) => f.message)).size} of ${viewports} viewports clean; ${findings[0].message}`
        : `${viewports} viewports clean`,
      findings,
      artifacts: (report.viewports || []).map((v) => v.screenshot).filter(Boolean),
      metrics: { viewports, findings: findings.length },
    })}\n`,
  );

  process.exit(findings.length ? 1 : 0);
}

main();
