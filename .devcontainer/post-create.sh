#!/usr/bin/env bash
set -euo pipefail

sudo chown -R "$(id -u):$(id -g)" "$HOME/.bun" "$HOME/.cache" "$(pwd)/node_modules" 2>/dev/null || true

git config --global --add safe.directory "$(pwd)" || true
git config --global core.autocrlf input
git config --global core.eol lf
git lfs install --skip-repo

HUSKY=0 bun install --frozen-lockfile
bun run workspace:vscode

if [ "${KILO_DEVCONTAINER_INSTALL_PLAYWRIGHT:-1}" = "1" ]; then
  (cd packages/kilo-vscode && bunx playwright install chromium)
  (cd packages/kilo-ui && bunx playwright install chromium)
fi
