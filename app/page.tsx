'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Stock = {
  id: string
  ticker: string
  name: string
  quotes: {
    price: number | null
    change_percent: number | null
    quality: string | null
    fetched_at: string | null
  } | null
}

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function isStale(fetchedAt: string | null) {
  if (!fetchedAt) return true
  const diffMinutes = (Date.now() - new Date(fetchedAt).getTime()) / 60000
  return diffMinutes > 30
}

export default function Home() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('stocks')
      .select('id, ticker, name, quotes ( price, change_percent, quality, fetched_at )')
      .eq('is_active', true)
      .order('ticker')
      .then(({ data }) => {
        setStocks((data as unknown as Stock[]) ?? [])
        setLoading(false)
      })
  }, [])

  const filtered = useMemo(() => {
    if (!query) return stocks.slice(0, 30)
    const q = query.toUpperCase()
    return stocks
      .filter((s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q))
      .slice(0, 30)
  }, [stocks, query])

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 max-w-[480px] mx-auto">
      <h1
        className="text-2xl font-bold bg-clip-text text-transparent"
        style={{
          backgroundImage:
            'linear-gradient(135deg, #0F172A 0%, #3B82F6 25%, #8B5CF6 50%, #EC4899 75%, #F43F5E 100%)',
        }}
      >
        Selamat datang
      </h1>
      <p className="text-slate-400 text-sm mt-1">
        {stocks.length > 0 ? `${stocks.length} saham siap dipantau` : 'Memuat data saham...'}
      </p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cari kode atau nama saham"
        className="w-full mt-4 rounded-xl bg-white/5 border border-white/10 px-4 py-3 text-sm placeholder:text-slate-500 focus:outline-none focus:border-[#3B82F6]"
      />

      <div className="mt-6 space-y-2">
        {loading && <p className="text-slate-500 text-sm">Memuat...</p>}

        {!loading && filtered.length === 0 && (
          <p className="text-slate-500 text-sm">Saham tidak ditemukan.</p>
        )}

        {filtered.map((stock) => {
          const quote = stock.quotes
          const hasPrice = quote?.price != null
          const stale = isStale(quote?.fetched_at ?? null)
          const up = (quote?.change_percent ?? 0) >= 0

          return (
            <Link
              key={stock.id}
              href={`/saham/${stock.ticker}`}
              className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors duration-200"
            >
              <div className="min-w-0">
                <p className="font-semibold text-sm">{stock.ticker}</p>
                <p className="text-slate-400 text-xs truncate">{stock.name}</p>
              </div>

              {hasPrice ? (
                <div className="text-right shrink-0 ml-2">
                  <p className="font-medium text-sm">{formatHarga(quote!.price)}</p>
                  <p
                    className={`text-xs ${up ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}
                  >
                    {up ? '+' : ''}
                    {quote!.change_percent?.toFixed(2) ?? '0.00'}%
                    {stale && <span className="text-slate-600 ml-1">· Data tertunda</span>}
                  </p>
                </div>
              ) : (
                <span className="text-slate-600 text-xs shrink-0 ml-2">Data harga menyusul</span>
              )}
            </Link>
          )
        })}
      </div>
    </main>
  )
}
