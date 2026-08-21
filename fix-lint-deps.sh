#!/bin/bash
set -e

apply() {
  local file=$1 line=$2 pattern=$3 repl=$4
  before=$(sed -n "${line}p" "$file")
  sed -i "${line}s/${pattern}/${repl}/" "$file"
  after=$(sed -n "${line}p" "$file")
  if [ "$before" == "$after" ]; then
    echo "⚠️  WARNING: TIDAK ADA PERUBAHAN di $file:$line"
    echo "    isi baris: $before"
  else
    echo "OK $file:$line"
  fi
}

# Bungkus createClient() jadi stabil pakai useState
apply app/screener/page.tsx 88 "const supabase = createClient()" "const [supabase] = useState(() => createClient())"
apply app/watchlist/page.tsx 50 "const supabase = createClient()" "const [supabase] = useState(() => createClient())"
apply app/hapus-akun/page.tsx 12 "const supabase = createClient()" "const [supabase] = useState(() => createClient())"
apply components/Header.tsx 14 "const supabase = createClient()" "const [supabase] = useState(() => createClient())"

# Tambahkan supabase (dan router jika perlu) ke dependency array
apply app/screener/page.tsx 159 '}, \[\])' '}, [supabase])'
apply app/watchlist/page.tsx 87 '}, \[\])' '}, [router, supabase])'
apply app/watchlist/page.tsx 102 '}, \[\])' '}, [supabase])'
apply app/watchlist/page.tsx 122 '}, \[\])' '}, [supabase])'
apply app/watchlist/page.tsx 148 '}, \[\])' '}, [supabase])'
apply app/watchlist/page.tsx 207 '}, \[user\])' '}, [user, supabase])'
apply app/hapus-akun/page.tsx 45 '}, \[\])' '}, [router, supabase])'
apply components/Header.tsx 29 '}, \[\])' '}, [supabase])'

echo "SELESAI - cek WARNING di atas kalau ada"
