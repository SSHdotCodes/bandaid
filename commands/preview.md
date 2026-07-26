---
description: Print exactly what Bandaid would re-inject if this session compacted right now
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" preview --stats`

Report these numbers to the user: how many of their messages would be replayed verbatim, how many turn digests, and the total token cost. If any messages fall outside the verbatim budget, say so plainly.
