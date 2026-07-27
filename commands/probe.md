---
description: Show what each of this project's probes last said about the current worktree
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" probe status`

Relay that verbatim.

`stale` means the worktree moved since the probe last ran; it will re-run on the
next stop. `abstain` means the probe declined — it has nothing to say here, and
its `summons` skill is what would produce the evidence it wants. Do not edit a
probe, weaken a threshold, or disarm one to get past a failure.
