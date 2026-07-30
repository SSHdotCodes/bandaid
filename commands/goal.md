---
description: Set an explicit Bandaid objective that survives until it is provably done
argument-hint: <objective> [--check "<command>"] [--seal "<command>"]
allowed-tools: Bash(node:*)
---

The user wants to set an explicit Bandaid goal.

Objective: $ARGUMENTS

Do this now:

1. If the objective above is empty, tell the user the usage is `/bandaid:goal <objective> [--check "<command>"] [--seal "<command>"]` and stop.
2. Separate the objective from an optional `--check "<command>"` and an optional `--seal "<command>"` if the user supplied either. Then run the Bash tool, quoting each part as a single argument:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal set --check "<command>" --seal "<command>" -- "<objective>"`

   Omit either flag entirely when the user did not give one. Do not invent a check command; a wrong one blocks the turn for the wrong reason. Do not invent a seal either — a held-out check only means something if the user chose what it holds out.
3. Have the criteria written by something that is not you:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal criteria --derive -- "<your own first>" "<your own second>"`

   The `--derive` flag runs a separate reader over the objective and the repository, and its list wins. The criteria you pass after `--` are only the fallback for when that reader cannot run, so write them properly: each one a condition that will be observably true when the objective is met — a command that exits 0, a file that exists and contains something specific, a behaviour that can be checked.

   Whichever list lands, it is the fixed bar for you and for any reviewer, and it is fixed once. The reason the derivation is not yours is that you are the one it binds: criteria written by the party being graded narrow in ways that are individually reasonable and collectively smaller than the objective, and neither you nor the reviewer would notice, because you would both be reading the same shrunken list.
4. **Relay the criteria to the user verbatim and stop for their acceptance.** Do not begin work in this turn. Say in one line that the goal is active, show the numbered criteria exactly as the command printed them, and ask whether that is the right bar. If a check was set, say the goal closes automatically the moment that command exits 0. If a seal was set, say a held-out check runs before the goal can close and that you will not be shown it or its result. If neither, say Bandaid will block the end of a turn until the completion audit passes or the continuation budget runs out.

   This pause is the point of the step. Criteria are fixed once, and the cheapest moment to fix a wrong bar is before any work has been done against it.
5. Bandaid also pulls the objective's negative clauses out as constraints, and hands them to any reviewer as vetoes. That extraction is a regex and it both over- and under-matches, so show the user what it actually found:

   `node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" goal show`

   Relay the `constraints:` lines verbatim, or say plainly that none were extracted. A constraint the user meant and Bandaid did not find is worth knowing now, while the goal is one command from being reset — not three turns later when a reviewer fails to veto something.

Then wait. Begin working on the objective when the user accepts the criteria, or amend them with `goal criteria --replace` if they do not.
