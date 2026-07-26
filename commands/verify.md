---
description: Run the active goal's check command and judge now, and show the verdict
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" verify`

Relay the verdict above to the user verbatim.

This is the same verification Bandaid runs when you try to end a turn, so a FAIL
here is exactly why the turn is being blocked. Do not argue with it and do not
weaken the check command — treat the output as the work that is left.
