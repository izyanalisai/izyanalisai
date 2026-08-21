#!/bin/bash
set -e

# 1. Tambah rule ignore underscore-prefixed vars/args di eslint.config.mjs
python3 << 'PYEOF'
path = "eslint.config.mjs"
with open(path) as f:
    content = f.read()

old = "  ...nextTs,\n"
new = """  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
"""
if old not in content:
    raise SystemExit("PATTERN NOT FOUND - cek manual eslint.config.mjs")
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("eslint.config.mjs updated")
PYEOF

# 2. Ganti window.location.href jadi router.push di StockDetail.tsx
sed -i "s|onClick={() => (window.location.href = '/trading-plan')}|onClick={() => router.push('/trading-plan')}|" components/StockDetail.tsx

echo "SELESAI"
