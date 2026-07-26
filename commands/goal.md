---
description: Set an explicit Bandaid objective that survives until it is provably done
argument-hint: <objective> [--check "<command>"]
allowed-tools: Bash(node:*)
---

The user wants to set an explicit Bandaid goal.

Objective: $ARGUMENTS

Do this now:

1. If the objective above is empty, tell the user the usage is `/bandaid:goal <objective> [--check "<command>"]` and stop.
2. Separate the objective from an optional `--check "<command>"` if the user supplied one. Then run the Bash tool, quoting each part as a single argument:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal set --check "<command>" -- "<objective>"`

   Omit `--check "<command>"` entirely when the user did not give one. Do not invent a check command; a wrong one blocks the turn for the wrong reason.
3. Derive 2–5 acceptance criteria from the objective as the user wrote it, and record them:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal criteria -- "<first>" "<second>"`

   Each one states a condition that will be observably true when the objective is met — a command that exits 0, a file that exists and contains something specific, a behaviour that can be checked. Cover the objective as written and nothing more: criteria that quietly narrow it become the new, smaller goal, because from here on this list is the bar for both you and any reviewer. They are fixed once, so get them right rather than fast.
4. Confirm to the user in one line that the goal is active, and show the criteria. If a check was set, say the goal closes automatically the moment that command exits 0. If not, say Bandaid will block the end of a turn until the completion audit passes or the continuation budget runs out.

Then begin working on the objective.
