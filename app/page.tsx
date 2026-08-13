'use client'

import { createClient } from '@/lib/supabase/client'
import { getPostLoginPath } from '@/lib/auth-flow'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Stock = {
  id: string
  ticker: string
  name: string
  quotes: { price: number | null; previous_close: number | null } | null
}

function formatHarga(n: number | null) {
  if (n === null || n === undefined) return '-'
  return new Intl.NumberFormat('id-ID').format(n)
}

function pctChange(price: number | null, prev: number | null) {
  if (price === null || prev === null || prev === 0) return null
  return ((price - prev) / prev) * 100
}

export default function Home() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (user) {
        const path = await getPostLoginPath(supabase, user.id)
        if (path !== '/') window.location.href = path
      }
    })
    supabase
      .from('stocks')
      .select('id, ticker, name, quotes ( price, previous_close )')
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
          const price = stock.quotes?.price ?? null
          const prev = stock.quotes?.previous_close ?? null
          const pct = pctChange(price, prev)
          const up = pct !== null && pct >= 0

          return (
            <Link
              key={stock.id}
              href={`/saham/${stock.ticker}`}
              className="flex items-center justify-between rounded-xl bg-white/5 border border-white/10 px-4 py-3 hover:border-[#8B5CF6] transition-colors"
            >
              <div>
                <p className="font-semibold text-sm">{stock.ticker}</p>
                <p className="text-slate-400 text-xs">{stock.name}</p>
              </div>
              {price !== null ? (
                <div className="text-right">
                  <p className="font-medium text-sm">{formatHarga(price)}</p>
                  {pct !== null && (
                    <p className={`text-xs ${up ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                      {up ? '+' : ''}
                      {pct.toFixed(2)}%
                    </p>
                  )}
                </div>
              ) : (
                <span className="text-slate-600 text-xs">Data menyusul</span>
              )}
            </Link>
          )
        })}
      </div>
    </main>
  )
}
