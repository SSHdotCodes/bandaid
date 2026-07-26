#!/bin/sh
# Ground truth: the legacy symbol is still exported, so the port is not done.
if grep -q retryLegacy src/client.js; then
  echo "src/client.js still exports retryLegacy"
  exit 1
fi
exit 0
