---
name: bandaid-browser-verify
description: >
  Verify a UI change by driving a real browser at real viewport sizes and emitting a
  machine-gradable report. Use when a Bandaid probe reports "no current browser report",
  when a goal's acceptance criteria mention layout, responsiveness, mobile, overflow, or a
  page rendering correctly, or when the user asks whether a change actually looks right in
  a browser rather than whether its unit tests pass. Produces
  .bandaid/artifacts/browser/report.json, which the browser probe grades by exit code.
  Not for unit tests of components, and not for visual taste review.
---

# Browser verification

You are producing **evidence**, not a verdict. The probe grades the report by
counting things in it. A report that omits a failure does not make the failure
go away — it makes the next probe run contradict you.

## What the probe will count

Six checks, all mechanical. Your report either contains what they need or it
does not.

| # | It fails unless | Why it is here |
|---|---|---|
| 1 | every declared viewport is present | a missing width is not a passing width |
| 2 | `consoleErrors` is empty at every viewport | an uncaught error is a broken page even when it renders |
| 3 | `failedRequests` has no 4xx or 5xx | a page that renders from cache is not a page that works |
| 4 | `overflow.pageOverflow` is false everywhere | the single most common mobile regression there is |
| 5 | every `steps[].ok` and `assertions[].ok` is true | the journey completed and the change did what it was for |
| 6 | every named screenshot exists and is **over 1 KB** | see below |

Check 6 is the anti-fabrication gate, and it is the reason this skill insists
you actually open a browser. The cheapest way to pass a browser probe is to
write a clean `report.json` without running anything. A real PNG per viewport is
a crude, cheap barrier to exactly that. Do not write a report for screenshots
you did not take.

## 1. Get a page up

Start the project's dev server **yourself**, in this session, and leave it
running only for this check. Note the URL.

Do not put the server start inside the probe script. Probes are launched
detached by a hook; a probe that owns a server orphans processes, collides on
ports, and can hang a session. The probe reads files. The skill drives
processes.

If you cannot start it, write **no report** and tell the user what is missing.
An absent report abstains, which is honest. A fabricated one fails.

## 2. Pick a driver

In this order, first one that is present:

1. **The project's own.** `playwright`, `@playwright/test`, `puppeteer`, or
   `cypress` in `package.json`. Most projects with a frontend already have one.
   The template targets Playwright; Puppeteer differs in two lines, noted there.
2. **`npx playwright`**, but only if `npx playwright --version` succeeds *and*
   browsers are already installed (`~/.cache/ms-playwright` is non-empty).
   **Never run `playwright install`** — downloading 300 MB inside a verification
   is a side effect nobody asked for.
3. **A browser MCP server**, if this session has one. Drive it directly and
   write the same report shape by hand.
4. **None of the above.** Write no report. Tell the user which of the three
   would be cheapest for this project to add, and stop.

## 3. Drive it, at three widths, as a user

375×812, 768×1024, 1440×900 — unless `.bandaid/browser.json` declares others.

At each width:

- navigate to the start URL and wait for the network to settle;
- **exercise the primary interaction the change touched.** Click it, type in it,
  submit it. A page that renders and cannot be used has not been verified;
- collect console errors and failed requests **for the whole visit**, not just
  at the end;
- run the overflow evaluate below;
- take a full-page screenshot into `$BANDAID_ARTIFACT_DIR`.

The overflow check, which is the load-bearing eight lines:

```js
await page.evaluate(() => ({
  pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  overflow: [...document.querySelectorAll('*')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')
    .slice(0, 20)
    .map((el) => ({ sel: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
                    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
}));
```

That turns "does this look broken on a phone" into an integer.

## 4. Write 2–5 assertions for the change under test

Each one an observable fact at a specific viewport:

- "the CTA is inside the viewport at 375 wide"
- "the nav collapses to a hamburger below 768"
- "the table scrolls rather than overflowing the page"

These are yours to choose — you know what the change was meant to do — and they
are graded as booleans, so state them where you can actually tell.

## 5. Emit the report, then stop

`$BANDAID_ARTIFACT_DIR/report.json`:

```json
{
  "schema": "bandaid.browser/1",
  "url": "http://localhost:5173/pricing",
  "stamp": "<the value of $BANDAID_STAMP>",
  "viewports": [
    {
      "name": "mobile", "width": 375, "height": 812,
      "screenshot": "375x812.png",
      "consoleErrors": [],
      "failedRequests": [],
      "overflow": { "pageOverflow": false, "overflow": [] },
      "steps": [{ "step": "add to cart", "ok": true }],
      "assertions": [{ "id": "cta-visible", "ok": true, "detail": "Get started at y=612" }]
    }
  ]
}
```

`stamp` is how the probe knows the report describes *this* worktree rather than
an earlier one. Copy `$BANDAID_STAMP` into it verbatim; a report without it, or
with a stale one, abstains rather than passing.

Do not summarize the result as "looks good". The probe reads the file.

## Reading a failure

- **overflow at one width only** — almost always a fixed pixel width or a
  `min-width` on a grid child. The `sel` in the report names the element.
- **console errors at every width** — not a layout problem. Something threw
  during the journey; the error text is in the report.
- **a step failed** — the target was not present, visible, or interactable. That
  is the change not working, not the probe being fussy.
- **the probe abstained** — no report, or a stale one. Run this skill again;
  the worktree moved since the last one.

## What this skill does not do

Visual taste. "It would look better with more spacing" is not a finding and the
probe cannot grade it. `rubric.md` is the narrow exception: it covers the
failures screenshots catch and counters cannot, and it is deliberately bounded
so that a reviewer cannot return an unbounded list of preferences.
