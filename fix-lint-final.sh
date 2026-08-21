#!/bin/bash
set -e

python3 << 'PYEOF'
path = "app/screener/page.tsx"
with open(path) as f:
    content = f.read()

old_func = """  function volumeBucket(vol: number | null): VolumeFilter | null {
    if (vol === null || vol === undefined) return null
    if (vol < volumeQuartiles.p25) return 'RENDAH'
    if (vol < volumeQuartiles.p75) return 'SEDANG'
    return 'TINGGI'
  }

  const commonFiltered = useMemo(() => {
    let list = stocks"""

new_func = """  const commonFiltered = useMemo(() => {
    function volumeBucket(vol: number | null): VolumeFilter | null {
      if (vol === null || vol === undefined) return null
      if (vol < volumeQuartiles.p25) return 'RENDAH'
      if (vol < volumeQuartiles.p75) return 'SEDANG'
      return 'TINGGI'
    }

    let list = stocks"""

count = content.count(old_func)
if count != 1:
    raise SystemExit(f"PATTERN DITEMUKAN {count} KALI (harus 1) - cek manual")

content = content.replace(old_func, new_func, 1)

# hapus volumeBucket dari dependency array
content = content.replace(
    "], [stocks, query, marketCapFilter, volumeFilter, volumeBucket, statusFilter, tierFilter, signalMap])",
    "], [stocks, query, marketCapFilter, volumeFilter, volumeQuartiles, statusFilter, tierFilter, signalMap])"
)

with open(path, "w") as f:
    f.write(content)
print("OK - volumeBucket dipindah ke dalam useMemo")
PYEOF

echo "SELESAI"
