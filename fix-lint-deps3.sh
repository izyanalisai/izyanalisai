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

apply app/watchlist/page.tsx 148 '}, \[user\])' '}, [user, supabase])'

# StockDetail: sengaja di-disable, bukan ditambah ke deps (loadWallet/loadSignal
# belum useCallback, resiko infinite loop kalau dipaksa masuk deps array)
sed -i '270i\    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadSignal/loadWallet/signalTier sengaja tidak masuk deps: belum di-useCallback, resiko infinite loop; effect ini sengaja hanya re-run saat ticker berubah' components/StockDetail.tsx

echo "SELESAI"
