#!/usr/bin/env bash
# Signs this release of Maratón for xuper-plugin/maraton with the author key, then checks it.
#
#   scripts/sign-release.sh <path to Kino's plugins/sdk> [--check-only]
#
# The key lives OUTSIDE the repository (default ~/.config/maraton-signing/xuper-plugin-author-key.pem, mode 600;
# override with MARATON_SIGNING_KEY). It is the identity Kino pins at the first install: losing it means everyone
# reinstalls, leaking it means anyone can ship updates as us. Never copy it into this folder.
# Run it after the LAST change to plugin.js and to "version": a signature covers both, and validate fails otherwise.
set -euo pipefail
SDK="${1:?usage: scripts/sign-release.sh <kino>/plugins/sdk [--check-only]}"
KEY="${MARATON_SIGNING_KEY:-$HOME/.config/maraton-signing/xuper-plugin-author-key.pem}"
REPO="xuper-plugin/maraton"
cd "$(dirname "$0")/.."
if git ls-files --error-unmatch '*.pem' >/dev/null 2>&1; then echo "a .pem file is tracked: remove it before signing" >&2; exit 1; fi
if [[ "${2:-}" != "--check-only" ]]; then
  [[ -f "$KEY" ]] || { echo "no author key at $KEY" >&2; exit 1; }
  node "$SDK/seal.mjs" --sign --repo "$REPO" --key "$KEY"
fi
npm test
node "$SDK/validate.mjs" . --repo "$REPO"
