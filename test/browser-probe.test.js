'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

/**
 * The browser probe's grader, which ships as a template projects copy.
 *
 * It is the one shipped grader that never opens a browser: the skill drives the
 * browser and writes a report, and this counts what is in it. Testing it here
 * is testing the gate, which is the part that decides whether a UI change is
 * allowed to close a goal.
 */

const TEMPLATE = path.join(__dirname, '..', 'skills', 'browser-verify', 'template', 'browser.js');

const scratch = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A viewport entry that passes every gate, so each test can break exactly one. */
function cleanViewport(name, overrides = {}) {
  return {
    name,
    width: name === 'mobile' ? 375 : name === 'tablet' ? 768 : 1440,
    height: 800,
    screenshot: `${name}.png`,
    consoleErrors: [],
    failedRequests: [],
    overflow: { pageOverflow: false, overflow: [] },
    steps: [{ step: 'open', ok: true }],
    assertions: [{ id: 'cta-visible', ok: true }],
    ...overrides,
  };
}

function grade(report, { screenshotBytes = 4096, stamp = 'now', reportStamp = 'now' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandaid-browser-'));
  scratch.push(dir);

  if (report) {
    const body = reportStamp === null ? report : { ...report, stamp: reportStamp };
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(body));
    for (const viewport of report.viewports || []) {
      if (!viewport.screenshot || screenshotBytes === null) continue;
      fs.writeFileSync(path.join(dir, viewport.screenshot), Buffer.alloc(screenshotBytes, 0x41));
    }
  }

  const result = spawnSync(process.execPath, [TEMPLATE], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, BANDAID_ARTIFACT_DIR: dir, BANDAID_STAMP: stamp },
  });

  let detail = null;
  const lines = String(result.stdout || '').trim().split('\n');
  try {
    detail = JSON.parse(lines[lines.length - 1]);
  } catch {
    /* the abstain paths print nothing structured */
  }
  return { exit: result.status, detail, stderr: String(result.stderr || '') };
}

const ALL_THREE = { viewports: [cleanViewport('mobile'), cleanViewport('tablet'), cleanViewport('desktop')] };

describe('the browser grader', () => {
  it('passes a clean report at every required width', () => {
    const result = grade(ALL_THREE);
    assert.equal(result.exit, 0);
    assert.equal(result.detail.metrics.findings, 0);
  });

  it('abstains when nobody has run the skill', () => {
    const result = grade(null);
    assert.equal(result.exit, 78, 'no report is not a passing report');
    assert.match(result.stderr, /bandaid-browser-verify/, 'and it names the skill that would produce one');
  });

  it('abstains on a report describing an earlier worktree', () => {
    // Stale evidence is not evidence. This is the gate that stops a report from
    // three edits ago closing a goal.
    const result = grade(ALL_THREE, { reportStamp: 'an-earlier-worktree' });
    assert.equal(result.exit, 78);
    assert.match(result.stderr, /earlier state/);
  });

  it('fails when a required viewport is simply missing', () => {
    const result = grade({ viewports: [cleanViewport('mobile'), cleanViewport('tablet')] });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /no report for the desktop viewport/);
  });

  it('fails on a console error, however well the page renders', () => {
    const result = grade({
      viewports: [cleanViewport('mobile', { consoleErrors: ['TypeError: undefined is not a function'] }), cleanViewport('tablet'), cleanViewport('desktop')],
    });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /console error at mobile/);
  });

  it('fails on horizontal overflow, the commonest mobile regression there is', () => {
    const result = grade({
      viewports: [
        cleanViewport('mobile', { overflow: { pageOverflow: true, overflow: [{ sel: 'div#pricing', scrollWidth: 412, clientWidth: 375 }] } }),
        cleanViewport('tablet'),
        cleanViewport('desktop'),
      ],
    });
    assert.equal(result.exit, 1);
    const findings = JSON.stringify(result.detail.findings);
    assert.match(findings, /scrolls horizontally at mobile/);
    assert.match(findings, /div#pricing overflows at mobile \(375px\) \(412 > 375\)/, 'and it names the element');
  });

  it('fails a failed request', () => {
    const result = grade({
      viewports: [cleanViewport('mobile', { failedRequests: [{ status: 500, url: '/api/cart' }] }), cleanViewport('tablet'), cleanViewport('desktop')],
    });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /failed request at mobile \(375px\): 500/);
  });

  it('fails a step the journey could not complete', () => {
    const result = grade({
      viewports: [cleanViewport('mobile', { steps: [{ step: 'add to cart', ok: false }] }), cleanViewport('tablet'), cleanViewport('desktop')],
    });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /step \\"add to cart\\" failed at mobile/);
  });

  it('fails an assertion the change was supposed to satisfy', () => {
    const result = grade({
      viewports: [cleanViewport('mobile', { assertions: [{ id: 'nav-collapses', ok: false }] }), cleanViewport('tablet'), cleanViewport('desktop')],
    });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /assertion \\"nav-collapses\\" failed at mobile/);
  });

  it('refuses a clean report written without opening a browser', () => {
    // The anti-fabrication gate, and the reason it exists: the cheapest way to
    // pass a browser probe is to write a perfect report and take no screenshots.
    const result = grade(ALL_THREE, { screenshotBytes: 12 });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /no real screenshot/);
  });

  it('refuses a viewport that names no screenshot at all', () => {
    const result = grade({
      viewports: [cleanViewport('mobile', { screenshot: null }), cleanViewport('tablet'), cleanViewport('desktop')],
    });
    assert.equal(result.exit, 1);
    assert.match(JSON.stringify(result.detail.findings), /no screenshot named for mobile/);
  });

  it('reports every finding, not just the first', () => {
    const result = grade({
      viewports: [
        cleanViewport('mobile', { consoleErrors: ['boom'], overflow: { pageOverflow: true, overflow: [] } }),
        cleanViewport('tablet'),
        cleanViewport('desktop'),
      ],
    });
    assert.ok(result.detail.findings.length >= 2, 'one fix per turn is slower than knowing all of them');
  });
});
