#!/bin/bash
set -e

python3 << 'PYEOF'
path = "app/screener/page.tsx"
with open(path) as f:
    content = f.read()

old = "], [stocks, query, marketCapFilter, volumeFilter, volumeQuartiles, statusFilter, tierFilter, signalMap])"
new = "], [stocks, query, marketCapFilter, volumeFilter, volumeQuartiles.p25, volumeQuartiles.p75, statusFilter, tierFilter, signalMap])"

count = content.count(old)
if count != 1:
    raise SystemExit(f"PATTERN DITEMUKAN {count} KALI (harus 1) - cek manual")

content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("OK - deps disesuaikan jadi volumeQuartiles.p25/.p75")
PYEOF

echo "SELESAI"
