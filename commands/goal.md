---
description: Set an explicit Bandaid objective that survives until it is provably done
argument-hint: <objective>
allowed-tools: Bash(node:*)
---

The user wants to set an explicit Bandaid goal.

Objective: $ARGUMENTS

Do this now:

1. If the objective above is empty, tell the user the usage is `/bandaid:goal <objective>` and stop.
2. Otherwise run the Bash tool with this command, substituting the objective as a single properly quoted argument:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal set -- "<objective>"`

3. Confirm to the user in one line that the goal is active, and state that Bandaid will now block the end of a turn until the completion audit passes or the continuation budget runs out.

Then begin working on the objective.
