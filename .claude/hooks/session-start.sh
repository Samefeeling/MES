#!/bin/bash
# SessionStart hook for Claude Code on the web — installs npm deps so
# `npm run typecheck` and `npm test` work immediately in the session.
set -euo pipefail

# Only run in the remote (web) environment; locally the user has their own toolchain.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Idempotent: npm install is a no-op when node_modules matches package-lock.json.
# Preferred over `npm ci` so cached state from a prior session can be reused.
npm install --no-audit --no-fund --loglevel=error
