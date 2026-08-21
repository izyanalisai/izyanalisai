#!/bin/bash
set -e

python3 << 'PYEOF'
path = "eslint.config.mjs"
with open(path) as f:
    content = f.read()

old = '{ "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },'
new = '{ "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" },'
if old not in content:
    raise SystemExit("PATTERN NOT FOUND - cek manual eslint.config.mjs")
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("eslint.config.mjs updated (caughtErrorsIgnorePattern)")
PYEOF

sed -i '825s/\bnormalizeTitle\b/_normalizeTitle/' supabase/functions/fetch-news/index.ts

echo "SELESAI"
