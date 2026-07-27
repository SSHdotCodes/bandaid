# Screenshot rubric

For the failures a counter cannot reach. Use this only after the mechanical
checks in `SKILL.md` have passed — it is not a substitute for them, and it does
not override them.

Grade each screenshot against these four, and **only** these four. Report a
failure only when you can name the element and the viewport it happens at.

1. **Text is fully visible.** Not clipped by its container, not overlapping
   another element, not truncated without an ellipsis.

2. **Interactive targets are reachable.** Nothing important sits under a fixed
   header or footer. Nothing requires a horizontal scroll to reach. Tap targets
   are not smaller than roughly 24px at mobile widths.

3. **Layout intent survives.** A grid has not collapsed to one column at 1440px.
   A modal is inside the viewport. A sidebar has not overlapped the content it
   sits beside.

4. **Loading and empty states are not shown as final states.** A skeleton in the
   last screenshot of a step is a failure, not a style choice.

## Out of scope

Aesthetic judgement. Brand consistency. Copy quality. Spacing you would prefer
to be different. Anything you would phrase beginning with "consider" or "it
would be nicer if".

**If you would say "it would look better…", that is not a finding.**

This paragraph is the most important one in the file. The failure mode of a
model grading a screenshot is an unbounded list of taste notes, and a probe that
returns one never passes — which makes it worse than no probe at all, because a
gate that never opens gets switched off within a day.

## Output

One line per finding:

```
<viewport> <selector or visible text> — <which of the four> — <what is wrong>
```

Nothing at all if there is nothing. "Looks good" is not a finding either.
