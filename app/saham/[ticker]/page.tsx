import StockDetail from '@/components/StockDetail'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>
}): Promise<Metadata> {
  const { ticker } = await params
  return {
    title: `${ticker.toUpperCase()} — IzyAnalisAi`,
    description: `Analisa teknikal saham ${ticker.toUpperCase()} di IzyAnalisAi. Signal BUY/SELL/NETRAL berbasis data IDX EOD.`,
  }
}

export default async function SahamPage({
  params,
}: {
  params: Promise<{ ticker: string }>
}) {
  const { ticker } = await params
  const supabase = await createClient()

  const { data: stock } = await supabase
    .from('stocks')
    .select('ticker')
    .eq('ticker', ticker.toUpperCase())
    .maybeSingle()

  if (!stock) {
    notFound()
  }

  return <StockDetail ticker={ticker.toUpperCase()} />
}
