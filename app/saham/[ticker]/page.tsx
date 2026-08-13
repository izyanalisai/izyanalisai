import StockDetail from '@/components/StockDetail'

export default async function SahamPage({
  params,
}: {
  params: Promise<{ ticker: string }>
}) {
  const { ticker } = await params
  return <StockDetail ticker={ticker.toUpperCase()} />
}
