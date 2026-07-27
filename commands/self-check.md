---
description: Report which acceptance criteria have measured evidence and which are only asserted
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bandaid.js" self-check`

Relay that verbatim.

It is the completion audit computed rather than asked for: coverage is arithmetic
over a ledger you can only append unverified claims to, so it is not something to
argue with. A criterion reported as `claimed-only` or `uncovered` is not a
criterion that passed — the fix is a check, a probe, or an expectation that fails
if it stops being true, not a more confident assertion.
