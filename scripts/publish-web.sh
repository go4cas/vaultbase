#!/usr/bin/env bash
# Re-split landing/ and site/ into the landing-only / docs-only branches
# and push them to the configured remotes. CF Pages picks up the push
# automatically.
#
# Required git remotes:
#   landing-origin  → git@github.com:<user>/<cogworks-landing-repo>.git
#   docs-origin     → git@github.com:<user>/<cogworks-docs-repo>.git
# TODO(brand): confirm the actual Cogworks landing/docs repo names during the
# landing-rebrand milestone (the old vaultbase-landing / vaultbase-docs targets
# are stale). These are git-remote names, not hardcoded URLs, so nothing breaks
# until this script is run.
#
# Usage:  ./scripts/publish-web.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ splitting landing/  → landing-only"
git subtree split -P landing -b landing-only --rejoin

echo "→ splitting site/     → docs-only"
git subtree split -P site    -b docs-only    --rejoin

echo "→ pushing landing-origin"
git push landing-origin landing-only:main

echo "→ pushing docs-origin"
git push docs-origin    docs-only:main

echo "✓ landing + docs published — CF Pages building"
