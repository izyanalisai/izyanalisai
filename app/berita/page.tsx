'use client'

import { createClient } from '@/lib/supabase/client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

type NewsItem = {
  id: string
  title: string
  summary: string | null
  source: string | null
  url: string | null
  category: 'global' | 'domestic'
  sentiment: 'positive' | 'neutral' | 'negative' | null
  related_tickers: string[] | null
  published_at: string
}

type CategoryTab = 'semua' | 'domestic' | 'global'

const SENTIMENT_LABEL: Record<string, string> = { positive: 'Positif', neutral: 'Netral', negative: 'Negatif' }
const SENTIMENT_COLOR: Record<string, string> = {
  positive: 'text-[#22C55E] bg-[#22C55E]/15',
  neutral: 'text-slate-300 bg-white/10',
  negative: 'text-[#EF4444] bg-[#EF4444]/15',
}

function timeAgo(iso: string) {
  const diffMinutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diffMinutes < 60) return `${diffMinutes} menit lalu`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} jam lalu`
  return `${Math.floor(diffHours / 24)} hari lalu`
}

export default function BeritaPage() {
  const [tab, setTab] = useState<CategoryTab>('semua')
  const [sentimentFilter, setSentimentFilter] = useState('')
  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    let active = true

    async function load() {
      setLoading(true)
      let query = supabase.from('news').select('*').order('published_at', { ascending: false }).limit(50)
      if (tab !== 'semua') query = query.eq('category', tab)
      if (sentimentFilter) query = query.eq('sentiment', sentimentFilter)
      const { data } = await query
      if (active) {
        setNews(data ?? [])
        setLoading(false)
      }
    }

    load()
    return () => {
      active = false
    }
  }, [tab, sentimentFilter])

  return (
    <main className="min-h-screen bg-[#0F172A] text-white px-4 py-6 pb-16 max-w-[480px] mx-auto lg:max-w-2xl lg:pl-64">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/" className="text-sm text-slate-400">‹</Link>
        <h1 className="text-xl font-bold">Semua Berita</h1>
      </div>

      <div className="flex gap-2 mb-3 border-b border-white/10">
        {([
          { key: 'semua', label: 'Semua' },
          { key: 'domestic', label: 'Domestik' },
          { key: 'global', label: 'Global' },
        ] as { key: CategoryTab; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors duration-200 ${
              tab === t.key ? 'border-[#8B5CF6] text-white' : 'border-transparent text-slate-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2 mb-4">
        <select
          value={sentimentFilter}
          onChange={(e) => setSentimentFilter(e.target.value)}
          className="rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-xs"
        >
          <option value="">Semua Sentimen</option>
          <option value="positive">Positif</option>
          <option value="neutral">Netral</option>
          <option value="negative">Negatif</option>
        </select>
      </div>

      {loading && <p className="text-slate-500 text-sm">Memuat...</p>}
      {!loading && news.length === 0 && (
        <p className="text-slate-500 text-sm text-center py-10">Sedang tidak ada berita terkait.</p>
      )}

      <div className="space-y-3">
        {news.map((n) => {
          const content = (
            <div className="rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium leading-snug">{n.title}</p>
                {n.sentiment && (
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${SENTIMENT_COLOR[n.sentiment]}`}>
                    {SENTIMENT_LABEL[n.sentiment]}
                  </span>
                )}
              </div>
              {n.summary && <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">{n.summary}</p>}
              <div className="flex items-center justify-between mt-2">
                <p className="text-[10px] text-slate-500">
                  {n.source ?? 'Sumber tidak diketahui'} · {timeAgo(n.published_at)}
                </p>
                {n.related_tickers && n.related_tickers.length > 0 && (
                  <p className="text-[10px] text-slate-500">{n.related_tickers.join(', ')}</p>
                )}
              </div>
            </div>
          )
          return n.url ? (
            <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" className="block">
              {content}
            </a>
          ) : (
            <div key={n.id}>{content}</div>
          )
        })}
      </div>
    </main>
  )
}
