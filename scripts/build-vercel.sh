#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"

echo "▶ Bundling workspace packages for Vercel runtime..."
mkdir -p "$ROOT/packages/shared/dist" "$ROOT/packages/stellar-sdk-helpers/dist"
esbuild "$ROOT/packages/shared/src/index.ts" \
  --bundle --platform=node --format=esm --packages=external \
  --outfile="$ROOT/packages/shared/dist/index.js"
esbuild "$ROOT/packages/stellar-sdk-helpers/src/index.ts" \
  --bundle --platform=node --format=esm --packages=external \
  --outfile="$ROOT/packages/stellar-sdk-helpers/dist/index.js"

echo "▶ Cleaning output directory…"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "▶ Building React app (base: /app/)…"
pnpm --filter @meridian/web build

echo "▶ Building docs (base: /docs/)…"
pnpm --filter @meridian/docs build

echo "▶ Assembling combined output…"
# Landing page → dist/index.html
cp "$ROOT/apps/landing/index.html" "$OUT/index.html"

# Landing favicons and OG image → dist/
cp "$ROOT/apps/landing/favicon-32x32.png" "$OUT/favicon-32x32.png"
cp "$ROOT/apps/landing/favicon-180x180.png" "$OUT/favicon-180x180.png"
cp "$ROOT/apps/landing/og_image.png" "$OUT/og_image.png"

# React SPA build → dist/app/
cp -r "$ROOT/apps/web/dist/." "$OUT/app/"

# VitePress docs → dist/docs/
cp -r "$ROOT/apps/docs/.vitepress/dist/." "$OUT/docs/"

echo "✓ dist/ structure:"
find "$OUT" -maxdepth 3 | sort

echo ""
echo "  Landing : $OUT/index.html ($(wc -c < "$OUT/index.html") bytes)"
echo "  App     : $OUT/app/index.html ($(wc -c < "$OUT/app/index.html") bytes)"
echo "  Docs    : $OUT/docs/index.html ($(wc -c < "$OUT/docs/index.html") bytes)"
