#!/bin/bash
set -e

apply() {
  local file=$1 line=$2 pattern=$3 repl=$4
  before=$(sed -n "${line}p" "$file")
  sed -i "${line}s/${pattern}/${repl}/" "$file"
  after=$(sed -n "${line}p" "$file")
  if [ "$before" == "$after" ]; then
    echo "⚠️  WARNING: TIDAK ADA PERUBAHAN di $file:$line — isi: $before"
  else
    echo "OK $file:$line"
  fi
}

apply app/profil/page.tsx 127 '}, \[userId\])' '}, [userId, supabase])'
apply app/profil/page.tsx 281 '}, \[\])' '}, [router, supabase])'
apply app/signal/page.tsx 150 '}, \[\])' '}, [supabase])'
apply app/screener/page.tsx 200 'volumeQuartiles, statusFilter' 'volumeQuartiles, volumeBucket, statusFilter'

echo "SELESAI"
