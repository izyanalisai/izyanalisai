#!/bin/bash
set -e

apply_text() {
  local file=$1 old=$2 new=$3
  count=$(grep -c -F -- "$old" "$file" || true)
  if [ "$count" -ne 1 ]; then
    echo "⚠️  WARNING: '$old' ditemukan $count kali di $file (harus 1) — SKIP"
    return
  fi
  python3 -c "
import sys
path = '$file'
with open(path) as f:
    c = f.read()
old = '''$old'''
new = '''$new'''
c = c.replace(old, new, 1)
with open(path, 'w') as f:
    f.write(c)
print('OK $file')
"
}

apply_text "app/screener/page.tsx" \
  "volumeQuartiles, volumeBucket, statusFilter" \
  "volumeBucket, statusFilter"

apply_text "app/watchlist/page.tsx" \
  "}, [addQuery, addOpen])" \
  "}, [addQuery, addOpen, supabase])"

echo "SELESAI"
