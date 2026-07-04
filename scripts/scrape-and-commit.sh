#!/usr/bin/env bash
#
# One-shot: fetch real photos for every town, then commit + push them so the
# live GitHub Pages site bakes them in (no more per-viewer live loading needed).
#
# RUN THIS ON YOUR OWN MACHINE (normal internet + Node 18+), NOT in the build
# sandbox — the sandbox's network policy blocks the image hosts.
#
#   ./scripts/scrape-and-commit.sh                 # all 120, keyless (Openverse+Wikimedia)
#   ./scripts/scrape-and-commit.sh --per-region=15 # top 15 per region first (rate-limit friendly)
#   UNSPLASH_ACCESS_KEY=xxx ./scripts/scrape-and-commit.sh   # higher quality with a key
#
# Any flags you pass are forwarded to scripts/fetch-media.mjs. It resumes safely:
# re-run it and it skips towns that already have photos, so rate-limit hiccups
# are fine — just run it again to fill the gaps.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node 18+ (https://nodejs.org) then re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node $(node --version) is too old — need 18+ (for built-in fetch)." >&2
  exit 1
fi

echo "→ Node $(node --version). Fetching photos…"
node scripts/fetch-media.mjs "$@"

echo "→ Staging images + manifests…"
git add images credits media.js

if git diff --cached --quiet; then
  echo "· No new photos landed (nothing to commit). Try re-running, or add an API key."
  exit 0
fi

git commit -m "Add fetched city photos + attribution"
echo "→ Pushing…"
git push
echo "✓ Pushed. GitHub Pages redeploys with real photos in ~1 minute."
